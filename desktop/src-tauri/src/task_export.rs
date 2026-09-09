//! Explicit user-selected exports. No arbitrary path is accepted from JavaScript.
use std::{io::Write, path::Path};

pub fn validate(task_id: &str, data: &str) -> Result<(), String> {
    if task_id.is_empty()
        || task_id.len() > 80
        || !task_id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        || data.len() > 64 * 1024 * 1024
    {
        return Err(
            "Invalid or oversized task export. Update Wisp or use the offline backup procedure."
                .into(),
        );
    }
    let value: serde_json::Value =
        serde_json::from_str(data).map_err(|_| "Invalid task export JSON.".to_string())?;
    if value["format"] != "wisp-task-export-v1" || value["task"]["id"] != task_id {
        return Err("The export does not match this task. Refresh and retry.".into());
    }
    Ok(())
}

pub fn save(path: &Path, data: &str) -> Result<(), String> {
    let result = (|| -> std::io::Result<()> {
        let mut file = tempfile::NamedTempFile::new_in(
            path.parent()
                .ok_or_else(|| std::io::Error::other("no parent"))?,
        )?;
        file.write_all(data.as_bytes())?;
        file.as_file().sync_all()?;
        file.persist(path).map_err(|e| e.error)?;
        Ok(())
    })();
    result.map_err(|_| "Could not save the export. Check available space and choose a writable folder, then retry.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_identity_and_atomically_replaces_only_the_chosen_file() {
        let data = r#"{"format":"wisp-task-export-v1","task":{"id":"tfixture"}}"#;
        assert!(validate("tfixture", data).is_ok());
        assert!(validate("other", data).is_err());
        assert!(validate("../fixture", data).is_err());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("export.json");
        std::fs::write(&path, "old").unwrap();
        save(&path, data).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), data);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        assert!(save(&dir.path().join("missing/export.json"), data).is_err());
    }
}
