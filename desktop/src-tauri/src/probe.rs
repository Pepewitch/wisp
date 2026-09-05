//! The authenticated `/api/capabilities` handshake.
//!
//! Nothing is saved, retargeted, or re-credentialed until this succeeds. It is
//! also where a daemon's instance identity is pinned: the proxy re-checks that
//! same value before the first write of every later launch.

use serde::Deserialize;
use url::Url;

use crate::urls::join_upstream;

#[derive(Debug, thiserror::Error)]
pub enum ProbeError {
    #[error("could not reach that daemon: {0}")]
    Unreachable(String),
    #[error("that token was rejected — check `wisp token` on the daemon host")]
    Unauthorized,
    #[error("that address answered with status {0}, which is not a Wisp daemon API")]
    Refused(u16),
    #[error("that address answered, but not with a Wisp daemon identity")]
    Malformed,
}

/// The subset of `/api/capabilities` the desktop shell acts on. Extra fields
/// are ignored so a newer daemon stays connectable.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonIdentity {
    pub instance_id: String,
    #[serde(default)]
    pub api_protocol_version: u32,
    #[serde(default)]
    pub version: String,
}

pub async fn probe(
    client: &reqwest::Client,
    base: &Url,
    token: &str,
) -> Result<DaemonIdentity, ProbeError> {
    let url = join_upstream(base, "api/capabilities", None)
        .map_err(|error| ProbeError::Unreachable(error.to_string()))?;
    let response = client
        .get(url)
        .header(
            http::header::AUTHORIZATION,
            format!("Bearer {}", token.trim()),
        )
        .send()
        .await
        .map_err(|error| ProbeError::Unreachable(error.to_string()))?;

    match response.status().as_u16() {
        200 => {}
        401 | 403 => return Err(ProbeError::Unauthorized),
        other => return Err(ProbeError::Refused(other)),
    }

    let identity: DaemonIdentity = response.json().await.map_err(|_| ProbeError::Malformed)?;
    if identity.instance_id.is_empty() {
        return Err(ProbeError::Malformed);
    }
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::DaemonIdentity;

    #[test]
    fn identity_parses_a_daemon_payload_and_tolerates_new_fields() {
        let identity: DaemonIdentity = serde_json::from_str(
            r#"{"apiProtocolVersion":3,"instanceId":"wisp-instance-aaaa","version":"0.4.0","commit":"abc","dirty":false,"capabilities":{"terminal":true},"somethingNew":1}"#,
        )
        .expect("parses");
        assert_eq!(identity.instance_id, "wisp-instance-aaaa");
        assert_eq!(identity.api_protocol_version, 3);
        assert_eq!(identity.version, "0.4.0");
    }

    #[test]
    fn a_payload_without_an_instance_id_is_not_a_daemon() {
        let identity: DaemonIdentity =
            serde_json::from_str(r#"{"instanceId":""}"#).expect("parses");
        assert!(identity.instance_id.is_empty());
    }
}
