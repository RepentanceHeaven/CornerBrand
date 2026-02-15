use crate::path_policy;
use image::imageops::{overlay, resize, FilterType};
use image::RgbaImage;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StampSettingsInput {
    pub position: String,
    #[serde(default = "default_size_preset")]
    pub size_preset: String,
    #[serde(default)]
    pub size_percent: Option<f32>,
    pub margin_percent: f32,
}

fn default_size_preset() -> String {
    "보통".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StampFileResult {
    pub input_path: String,
    pub ok: bool,
    pub output_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum CornerPosition {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Debug, Clone)]
struct StampSettings {
    position: CornerPosition,
    size_ratio: f32,
    margin_percent: f32,
}

impl TryFrom<StampSettingsInput> for StampSettings {
    type Error = String;

    fn try_from(value: StampSettingsInput) -> Result<Self, Self::Error> {
        let position = match value.position.as_str() {
            "좌상단" => CornerPosition::TopLeft,
            "우상단" => CornerPosition::TopRight,
            "좌하단" => CornerPosition::BottomLeft,
            "우하단" => CornerPosition::BottomRight,
            _ => return Err("유효하지 않은 위치 값입니다.".to_string()),
        };

        let size_ratio = if let Some(size_percent) = value.size_percent {
            if size_percent.is_finite() {
                size_percent.clamp(1.0, 300.0) / 100.0
            } else {
                match value.size_preset.as_str() {
                    "작음" => 0.08,
                    "보통" => 0.12,
                    "큼" => 0.16,
                    _ => return Err("유효하지 않은 크기 프리셋입니다.".to_string()),
                }
            }
        } else {
            match value.size_preset.as_str() {
                "작음" => 0.08,
                "보통" => 0.12,
                "큼" => 0.16,
                _ => return Err("유효하지 않은 크기 프리셋입니다.".to_string()),
            }
        };

        let margin_percent = value.margin_percent.clamp(0.0, 20.0);

        Ok(Self {
            position,
            size_ratio,
            margin_percent,
        })
    }
}

pub fn stamp_images(
    paths: &[String],
    settings_input: StampSettingsInput,
    logo_path: &Path,
    output_base_dir: Option<&Path>,
) -> Vec<StampFileResult> {
    let settings = match StampSettings::try_from(settings_input) {
        Ok(s) => s,
        Err(err) => {
            return paths
                .iter()
                .map(|path| failure_result(path.clone(), err.clone()))
                .collect();
        }
    };

    let logo = match image::open(logo_path) {
        Ok(img) => img.to_rgba8(),
        Err(e) => {
            let message = format!("로고 리소스를 읽지 못했습니다: {e}");
            return paths
                .iter()
                .map(|path| failure_result(path.clone(), message.clone()))
                .collect();
        }
    };

    paths
        .iter()
        .map(|input| {
            let input_path = Path::new(input);
            match stamp_single_image(input_path, &logo, &settings, output_base_dir) {
                Ok(output_path) => StampFileResult {
                    input_path: input.clone(),
                    ok: true,
                    output_path: Some(output_path.to_string_lossy().to_string()),
                    error: None,
                },
                Err(error) => failure_result(input.clone(), error),
            }
        })
        .collect()
}

fn stamp_single_image(
    input_path: &Path,
    logo_image: &RgbaImage,
    settings: &StampSettings,
    output_base_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    let format_info = path_policy::detect_supported_image(input_path)
        .ok_or_else(|| "지원하지 않는 파일 형식입니다. (jpg/png/webp)".to_string())?;

    let source = image::open(input_path)
        .map_err(|e| format!("이미지 파일을 읽지 못했습니다: {e}"))?
        .to_rgba8();

    let (width, height) = source.dimensions();
    if width == 0 || height == 0 {
        return Err("이미지 크기가 유효하지 않습니다.".to_string());
    }

    let short_side = width.min(height) as f32;
    let margin_px = ((short_side * settings.margin_percent / 100.0).round() as u32).max(0);
    let logo_max = logo_image.width().max(logo_image.height()).max(1);
    let target_max = ((short_side * settings.size_ratio).round() as u32).max(1);
    let scale = target_max as f32 / logo_max as f32;

    let target_width = ((logo_image.width() as f32 * scale).round() as u32).max(1);
    let target_height = ((logo_image.height() as f32 * scale).round() as u32).max(1);

    let resized_logo = resize(
        logo_image,
        target_width,
        target_height,
        FilterType::Lanczos3,
    );

    let max_x = width.saturating_sub(target_width);
    let max_y = height.saturating_sub(target_height);

    let (x, y) = match settings.position {
        CornerPosition::TopLeft => (margin_px.min(max_x), margin_px.min(max_y)),
        CornerPosition::TopRight => (max_x.saturating_sub(margin_px), margin_px.min(max_y)),
        CornerPosition::BottomLeft => (margin_px.min(max_x), max_y.saturating_sub(margin_px)),
        CornerPosition::BottomRight => (
            max_x.saturating_sub(margin_px),
            max_y.saturating_sub(margin_px),
        ),
    };

    let mut merged = source;
    overlay(&mut merged, &resized_logo, i64::from(x), i64::from(y));

    let output_path = path_policy::build_output_path(input_path, output_base_dir)?;
    image::DynamicImage::ImageRgba8(merged)
        .save_with_format(&output_path, format_info.format)
        .map_err(|e| format!("결과 이미지를 저장하지 못했습니다: {e}"))?;

    Ok(output_path)
}

fn failure_result(input_path: String, error: String) -> StampFileResult {
    StampFileResult {
        input_path,
        ok: false,
        output_path: None,
        error: Some(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn write_test_png(path: &Path, width: u32, height: u32, rgba: [u8; 4]) {
        let mut img = RgbaImage::new(width, height);
        for x in 0..width {
            for y in 0..height {
                img.put_pixel(x, y, image::Rgba(rgba));
            }
        }
        image::DynamicImage::ImageRgba8(img)
            .save(path)
            .expect("write png fixture");
    }

    #[test]
    fn stamp_images_stamps_generated_temp_png() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("cornerbrand-image-engine-{nonce}"));
        fs::create_dir_all(&root).expect("temp dir");

        let input_path = root.join("input.png");
        let logo_path = root.join("logo.png");
        write_test_png(&input_path, 48, 48, [240, 240, 240, 255]);
        write_test_png(&logo_path, 8, 8, [255, 0, 0, 255]);

        let settings = StampSettingsInput {
            position: "우하단".to_string(),
            size_preset: "보통".to_string(),
            size_percent: None,
            margin_percent: 2.0,
        };
        let paths = vec![input_path.to_string_lossy().to_string()];

        let results = stamp_images(&paths, settings, &logo_path, None);
        assert_eq!(results.len(), 1);
        assert!(results[0].ok, "expected success: {:?}", results[0].error);

        let output_path = PathBuf::from(results[0].output_path.as_ref().expect("output path"));
        assert!(output_path.exists(), "stamped output should exist");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stamp_images_accepts_size_percent_without_size_preset() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("cornerbrand-image-size-percent-{nonce}"));
        fs::create_dir_all(&root).expect("temp dir");

        let input_path = root.join("input.png");
        let logo_path = root.join("logo.png");
        write_test_png(&input_path, 48, 48, [240, 240, 240, 255]);
        write_test_png(&logo_path, 8, 8, [255, 0, 0, 255]);

        let settings: StampSettingsInput =
            serde_json::from_str(r#"{"position":"우하단","sizePercent":300,"marginPercent":0}"#)
                .expect("deserialize settings with sizePercent");

        let paths = vec![input_path.to_string_lossy().to_string()];
        let results = stamp_images(&paths, settings, &logo_path, None);

        assert_eq!(results.len(), 1);
        assert!(results[0].ok, "expected success: {:?}", results[0].error);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stamp_settings_clamps_size_percent_to_300() {
        let settings = StampSettings::try_from(StampSettingsInput {
            position: "우하단".to_string(),
            size_preset: "보통".to_string(),
            size_percent: Some(999.0),
            margin_percent: 0.0,
        })
        .expect("settings should be valid");

        assert_eq!(settings.size_ratio, 3.0);
    }
}
