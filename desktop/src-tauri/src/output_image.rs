//! An image can only be saved to a destination chosen in the native Save panel.
use base64::{engine::general_purpose::STANDARD, Engine};

pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

pub fn decode(name: &str, data: &str) -> Result<Vec<u8>, String> {
    if name.is_empty()
        || name.len() > 480
        || name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
        || data.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4
    {
        return Err("Invalid or oversized output image.".into());
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "Invalid output image encoding.".to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES
        || !(bytes.starts_with(b"\x89PNG\r\n\x1a\n")
            || bytes.starts_with(b"\xff\xd8\xff")
            || bytes.starts_with(b"GIF87a")
            || bytes.starts_with(b"GIF89a")
            || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP")))
    {
        return Err("Output must be a PNG, JPEG, GIF or WebP image up to 8 MiB.".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_paths_bad_encoding_unsupported_bytes_and_oversized_images() {
        let png = include_bytes!("../../../web/src/assets/output-sample.png");
        assert_eq!(decode("sample.png", &STANDARD.encode(png)).unwrap(), png);
        for name in ["../sample.png", "sample\n.png", "a\\b.png", ""] {
            assert!(decode(name, &STANDARD.encode(png)).is_err());
        }
        assert!(decode("image.png", "bad!").is_err());
        assert!(decode("image.svg", &STANDARD.encode(b"<svg/>")).is_err());
        assert!(decode(
            "large.png",
            &"A".repeat(MAX_IMAGE_BYTES.div_ceil(3) * 4 + 4)
        )
        .is_err());
    }
}
