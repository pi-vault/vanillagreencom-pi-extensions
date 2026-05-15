use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use serde_json::{json, Value};
use thiserror::Error;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, oneshot, RwLock};

use crate::state::snapshot::DashboardSnapshot;

use super::rpc::{
    DaemonStatus, RpcNotification, RpcRequest, RpcResponse, StateChangeParams, FRAME_TOO_LARGE,
    INTERNAL_ERROR, MAX_FRAME_BYTES, METHOD_NOT_FOUND, PARSE_ERROR,
};
use super::state::SharedState;

#[derive(Debug, Error)]
pub enum SocketError {
    #[error("socket io error at {path}: {source}", path = path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

pub async fn serve(
    socket_path: PathBuf,
    shared: Arc<SharedState>,
    started_at: Instant,
    mut shutdown_rx: oneshot::Receiver<()>,
    shutdown_tx: broadcast::Sender<()>,
) -> Result<(), SocketError> {
    if let Err(error) = tokio::fs::remove_file(&socket_path).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::debug!(path = %socket_path.display(), %error, "failed to remove stale socket");
        }
    }
    let listener = UnixListener::bind(&socket_path).map_err(|source| SocketError::Io {
        path: socket_path.clone(),
        source,
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) =
            std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
        {
            tracing::warn!(path = %socket_path.display(), %error, "failed to set socket mode");
        }
    }

    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown_rx => break,
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        let shared = Arc::clone(&shared);
                        let shutdown_tx = shutdown_tx.clone();
                        tokio::spawn(async move {
                            if let Err(error) = handle_connection(stream, shared, started_at, shutdown_tx).await {
                                tracing::debug!(%error, "dashboard daemon client disconnected");
                            }
                        });
                    }
                    Err(error) => tracing::warn!(%error, "dashboard daemon accept failed"),
                }
            }
        }
    }
    Ok(())
}

async fn handle_connection(
    stream: UnixStream,
    shared: Arc<SharedState>,
    started_at: Instant,
    shutdown_tx: broadcast::Sender<()>,
) -> Result<(), std::io::Error> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut frame = Vec::with_capacity(4096);
    loop {
        match read_bounded_frame(&mut reader, &mut frame).await? {
            FrameRead::Eof => return Ok(()),
            FrameRead::TooLarge => {
                write_json_line(
                    &mut write_half,
                    &RpcResponse::err(None, FRAME_TOO_LARGE, "frame exceeds 1 MiB"),
                )
                .await?;
                return Ok(());
            }
            FrameRead::Frame => {}
        }
        let request = match serde_json::from_slice::<RpcRequest>(&frame) {
            Ok(request) => request,
            Err(error) => {
                write_json_line(
                    &mut write_half,
                    &RpcResponse::err(None, PARSE_ERROR, error.to_string()),
                )
                .await?;
                continue;
            }
        };
        match request.method.as_str() {
            "get_snapshot" => {
                let snapshot = shared.snapshot.read().await.clone();
                write_ok_line(&mut write_half, request.id, snapshot).await?;
            }
            "get_status" => {
                let status = status_with_uptime(&shared.status, started_at).await;
                write_ok_line(&mut write_half, request.id, status).await?;
            }
            "subscribe_snapshots" => {
                let mut rx = shared.snapshots.subscribe();
                let snapshot = shared.snapshot.read().await.clone();
                write_ok_line(&mut write_half, request.id, json!({"subscribed": true})).await?;
                write_snapshot_notification(&mut write_half, &snapshot).await?;
                loop {
                    match rx.recv().await {
                        Ok(snapshot) => {
                            write_snapshot_notification(&mut write_half, &snapshot).await?;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return Ok(()),
                    }
                }
            }
            "tail_state" => {
                let mut rx = shared.snapshots.subscribe();
                let snapshot = shared.snapshot.read().await.clone();
                write_ok_line(&mut write_half, request.id, json!({"subscribed": true})).await?;
                write_state_change_notification(&mut write_half, &snapshot).await?;
                loop {
                    match rx.recv().await {
                        Ok(snapshot) => {
                            write_state_change_notification(&mut write_half, &snapshot).await?;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return Ok(()),
                    }
                }
            }
            "shutdown" => {
                write_ok_line(&mut write_half, request.id, json!({"shutdown": true})).await?;
                if shutdown_tx.send(()).is_err() {
                    tracing::debug!("daemon shutdown signal had no receivers");
                }
                return Ok(());
            }
            _ => {
                write_json_line(
                    &mut write_half,
                    &RpcResponse::err(request.id, METHOD_NOT_FOUND, "method not found"),
                )
                .await?;
            }
        }
    }
}

enum FrameRead {
    Frame,
    TooLarge,
    Eof,
}

async fn read_bounded_frame<R>(
    reader: &mut R,
    frame: &mut Vec<u8>,
) -> Result<FrameRead, std::io::Error>
where
    R: AsyncBufRead + Unpin,
{
    frame.clear();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return if frame.is_empty() {
                Ok(FrameRead::Eof)
            } else {
                Ok(FrameRead::Frame)
            };
        }
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            let take = newline + 1;
            if frame.len().saturating_add(take) > MAX_FRAME_BYTES {
                reader.consume(take);
                return Ok(FrameRead::TooLarge);
            }
            frame.extend_from_slice(&available[..take]);
            reader.consume(take);
            return Ok(FrameRead::Frame);
        }
        if frame.len().saturating_add(available.len()) > MAX_FRAME_BYTES {
            let take = available.len();
            reader.consume(take);
            return Ok(FrameRead::TooLarge);
        }
        let take = available.len();
        frame.extend_from_slice(available);
        reader.consume(take);
    }
}

async fn status_with_uptime(status: &RwLock<DaemonStatus>, started_at: Instant) -> DaemonStatus {
    let mut status = status.read().await.clone();
    status.uptime_secs = Some(started_at.elapsed().as_secs());
    status
}

async fn write_snapshot_notification<W>(
    writer: &mut W,
    snapshot: &DashboardSnapshot,
) -> Result<(), std::io::Error>
where
    W: AsyncWrite + Unpin,
{
    write_json_line(writer, &RpcNotification::new("snapshot", snapshot)).await
}

async fn write_state_change_notification<W>(
    writer: &mut W,
    snapshot: &DashboardSnapshot,
) -> Result<(), std::io::Error>
where
    W: AsyncWrite + Unpin,
{
    let params = StateChangeParams {
        path: snapshot.master_state_path.clone(),
        snapshot: snapshot.clone(),
    };
    write_json_line(writer, &RpcNotification::new("state_change", params)).await
}

async fn write_ok_line<W, T>(
    writer: &mut W,
    id: Option<Value>,
    result: T,
) -> Result<(), std::io::Error>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let response = RpcResponse::ok(id, result).map_err(std::io::Error::other)?;
    write_json_line(writer, &response).await
}

async fn write_json_line<W, T>(writer: &mut W, value: &T) -> Result<(), std::io::Error>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let mut line = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    line.push(b'\n');
    writer.write_all(&line).await
}

#[allow(dead_code)]
fn internal_error(id: Option<Value>, error: impl ToString) -> RpcResponse {
    RpcResponse::err(id, INTERNAL_ERROR, error.to_string())
}
