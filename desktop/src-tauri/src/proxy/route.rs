//! Strict parsing for capability-scoped connection routes.

use crate::registry::is_valid_connection_id;

pub(super) struct ProxyRoute<'a> {
    pub(super) capability: &'a str,
    pub(super) connection_id: &'a str,
    pub(super) route_revision: u32,
    /// `api/...`, exactly as it appeared on the request line.
    pub(super) rest: &'a str,
}

impl<'a> ProxyRoute<'a> {
    pub(super) fn parse(path: &'a str) -> Option<Self> {
        let rest = path.strip_prefix('/')?;
        let (capability, rest) = rest.split_once('/')?;
        let rest = rest.strip_prefix("connections/")?;
        let (connection_id, rest) = rest.split_once('/')?;
        if !is_valid_connection_id(connection_id) {
            return None;
        }
        let (raw_revision, rest) = rest.split_once('/')?;
        let route_revision = raw_revision.parse::<u32>().ok()?;
        if route_revision.to_string() != raw_revision {
            return None;
        }
        // Only the daemon API is reachable. There is no proxy route to a
        // daemon's web bundle, and no route that is not a daemon route.
        if rest != "api" && !rest.starts_with("api/") {
            return None;
        }
        Some(Self {
            capability,
            connection_id,
            route_revision,
            rest,
        })
    }
}
