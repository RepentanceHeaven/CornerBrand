use image::ImageFormat;
use std::fs;
use std::path::{Path, PathBuf};

pub const OUTPUT_DIR_NAME: &str = "CornerBrand_Output";

#[derive(Debug, Clone)]
pub struct SupportedFormat {
    pub format: ImageFormat,
    pub output_extension: String,
}

pub fn detect_supported_image(path: &Path) -> Option<SupportedFormat> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();

    let format = match extension.as_str() {
        "jpg" | "jpeg" => ImageFormat::Jpeg,
        "png" => ImageFormat::Png,
        "webp" => ImageFormat::WebP,
        _ => return None,
    };

    Some(SupportedFormat {
        format,
        output_extension: extension,
    })
}

pub fn is_supported_pdf(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

pub fn build_output_path(
    input_path: &Path,
    output_base_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    let format = detect_supported_image(input_path)
        .ok_or_else(|| "지원하지 않는 이미지 형식입니다. (jpg/png/webp)".to_string())?;

    let parent = input_path
        .parent()
        .ok_or_else(|| "입력 파일의 상위 경로를 찾을 수 없습니다.".to_string())?;

    let output_dir = resolve_output_dir(parent, output_base_dir)?;

    let stem = input_path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("image");

    let base_name = format!("{stem}_cornerbrand");

    let first = output_dir.join(format!("{}.{}", base_name, format.output_extension));
    if !first.exists() {
        return Ok(first);
    }

    let mut index = 1u32;
    loop {
        let candidate = output_dir.join(format!(
            "{}({}).{}",
            base_name, index, format.output_extension
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
        index = index.saturating_add(1);
    }
}

pub fn build_output_pdf_path(
    input_path: &Path,
    output_base_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    if !is_supported_pdf(input_path) {
        return Err("지원하지 않는 PDF 형식입니다. (.pdf)".to_string());
    }

    let parent = input_path
        .parent()
        .ok_or_else(|| "입력 파일의 상위 경로를 찾을 수 없습니다.".to_string())?;

    let output_dir = resolve_output_dir(parent, output_base_dir)?;

    let stem = input_path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("file");

    let base_name = format!("{stem}_cornerbrand");

    let first = output_dir.join(format!("{base_name}.pdf"));
    if !first.exists() {
        return Ok(first);
    }

    let mut index = 1u32;
    loop {
        let candidate = output_dir.join(format!("{}({}).pdf", base_name, index));
        if !candidate.exists() {
            return Ok(candidate);
        }
        index = index.saturating_add(1);
    }
}

pub fn build_report_path(
    input_dir: &Path,
    output_base_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    let output_dir = resolve_output_dir(input_dir, output_base_dir)?;

    let base_name = "cornerbrand_report";
    let first = output_dir.join(format!("{base_name}.json"));
    if !first.exists() {
        return Ok(first);
    }

    let mut index = 1u32;
    loop {
        let candidate = output_dir.join(format!("{}({}).json", base_name, index));
        if !candidate.exists() {
            return Ok(candidate);
        }
        index = index.saturating_add(1);
    }
}

fn resolve_output_dir(input_dir: &Path, output_base_dir: Option<&Path>) -> Result<PathBuf, String> {
    let base_dir = match output_base_dir {
        Some(path) => {
            ensure_directory(path)?;
            path
        }
        None => input_dir,
    };

    let output_dir = base_dir.join(OUTPUT_DIR_NAME);
    fs::create_dir_all(&output_dir).map_err(|e| format!("출력 폴더를 만들지 못했습니다: {e}"))?;

    if !output_dir.is_dir() {
        return Err("출력 경로가 디렉터리가 아닙니다.".to_string());
    }

    Ok(output_dir)
}

fn ensure_directory(path: &Path) -> Result<(), String> {
    if path.exists() {
        if path.is_dir() {
            return Ok(());
        }
        return Err("출력 폴더 경로가 디렉터리가 아닙니다.".to_string());
    }

    fs::create_dir_all(path).map_err(|e| format!("출력 폴더를 만들지 못했습니다: {e}"))?;
    if !path.is_dir() {
        return Err("출력 폴더 경로가 디렉터리가 아닙니다.".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn supported_extensions_are_detected() {
        assert!(detect_supported_image(Path::new("a.jpg")).is_some());
        assert!(detect_supported_image(Path::new("a.jpeg")).is_some());
        assert!(detect_supported_image(Path::new("a.png")).is_some());
        assert!(detect_supported_image(Path::new("a.webp")).is_some());
        assert!(detect_supported_image(Path::new("a.pdf")).is_none());
    }

    #[test]
    fn pdf_extension_is_detected() {
        assert!(is_supported_pdf(Path::new("a.pdf")));
        assert!(is_supported_pdf(Path::new("a.PDF")));
        assert!(!is_supported_pdf(Path::new("a.png")));
    }

    #[test]
    fn output_name_is_incremented_on_collision() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();

        let root = std::env::temp_dir().join(format!("cornerbrand-test-{nonce}"));
        fs::create_dir_all(&root).expect("temp dir");

        let input = root.join("sample.png");
        fs::write(&input, b"x").expect("input");

        let first = build_output_path(&input, None).expect("first path");
        fs::create_dir_all(first.parent().expect("parent")).expect("output dir");
        fs::write(&first, b"x").expect("first file");

        let second = build_output_path(&input, None).expect("second path");
        let name = second
            .file_name()
            .and_then(|n| n.to_str())
            .expect("name")
            .to_string();
        assert_eq!(name, "sample_cornerbrand(1).png");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn pdf_output_name_is_incremented_on_collision() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();

        let root = std::env::temp_dir().join(format!("cornerbrand-pdf-test-{nonce}"));
        fs::create_dir_all(&root).expect("temp dir");

        let input = root.join("sample.pdf");
        fs::write(&input, b"x").expect("input");

        let first = build_output_pdf_path(&input, None).expect("first path");
        fs::create_dir_all(first.parent().expect("parent")).expect("output dir");
        fs::write(&first, b"x").expect("first file");

        let second = build_output_pdf_path(&input, None).expect("second path");
        let name = second
            .file_name()
            .and_then(|n| n.to_str())
            .expect("name")
            .to_string();
        assert_eq!(name, "sample_cornerbrand(1).pdf");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn report_name_is_incremented_on_collision() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();

        let root = std::env::temp_dir().join(format!("cornerbrand-report-test-{nonce}"));
        fs::create_dir_all(&root).expect("temp dir");

        let first = build_report_path(&root, None).expect("first path");
        fs::create_dir_all(first.parent().expect("parent")).expect("output dir");
        fs::write(&first, b"x").expect("first file");

        let second = build_report_path(&root, None).expect("second path");
        let name = second
            .file_name()
            .and_then(|n| n.to_str())
            .expect("name")
            .to_string();
        assert_eq!(name, "cornerbrand_report(1).json");

        let _ = fs::remove_dir_all(&root);
    }
}
