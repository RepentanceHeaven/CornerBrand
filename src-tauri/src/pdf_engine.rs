use crate::image_engine::{StampFileResult, StampSettingsInput};
use crate::path_policy;
use image::{DynamicImage, GenericImageView, ImageBuffer, ImageFormat, Rgb};
use lopdf::{Dictionary, Document, Object, ObjectId};
use std::io::Cursor;
use std::path::{Path, PathBuf};

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
    size_ratio: f64,
    margin_percent: f64,
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
                f64::from(size_percent.clamp(1.0, 50.0) / 100.0)
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

        Ok(Self {
            position,
            size_ratio,
            margin_percent: f64::from(value.margin_percent.clamp(0.0, 20.0)),
        })
    }
}

pub fn stamp_pdfs(
    paths: &[String],
    settings_input: StampSettingsInput,
    logo_path: &Path,
    output_base_dir: Option<&Path>,
) -> Vec<StampFileResult> {
    let settings = match StampSettings::try_from(settings_input) {
        Ok(settings) => settings,
        Err(err) => {
            return paths
                .iter()
                .map(|path| failure_result(path.clone(), err.clone()))
                .collect();
        }
    };

    let logo_stream = match build_logo_stream(logo_path) {
        Ok(stream) => stream,
        Err(err) => {
            return paths
                .iter()
                .map(|path| failure_result(path.clone(), err.clone()))
                .collect();
        }
    };

    paths
        .iter()
        .map(|input| {
            let input_path = Path::new(input);
            match stamp_single_pdf(input_path, &settings, &logo_stream, output_base_dir) {
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

fn stamp_single_pdf(
    input_path: &Path,
    settings: &StampSettings,
    logo_stream: &[u8],
    output_base_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    if !path_policy::is_supported_pdf(input_path) {
        return Err("지원하지 않는 PDF 형식입니다. (.pdf)".to_string());
    }

    let mut doc = Document::load(input_path).map_err(|e| format!("PDF를 읽지 못했습니다: {e}"))?;
    let pages = doc.get_pages();
    if pages.is_empty() {
        return Err("페이지가 없는 PDF 파일입니다.".to_string());
    }

    for (page_number, page_id) in pages {
        let (page_width, page_height) = resolve_page_size(&doc, page_id, page_number)?;
        let (x, y, draw_width, draw_height) =
            compute_logo_rect(page_width, page_height, settings, logo_stream)?;

        let img = lopdf::xobject::image_from(logo_stream.to_vec())
            .map_err(|e| format!("로고 XObject 생성에 실패했습니다: {e}"))?;

        doc.insert_image(
            page_id,
            img,
            (x as f32, y as f32),
            (draw_width as f32, draw_height as f32),
        )
        .map_err(|e| format!("페이지 {page_number}에 로고 삽입 실패: {e}"))?;
    }

    let output_path = path_policy::build_output_pdf_path(input_path, output_base_dir)?;
    doc.save(&output_path)
        .map_err(|e| format!("결과 PDF를 저장하지 못했습니다: {e}"))?;

    Ok(output_path)
}

fn build_logo_stream(logo_path: &Path) -> Result<Vec<u8>, String> {
    let logo_bytes =
        std::fs::read(logo_path).map_err(|e| format!("로고 리소스를 읽지 못했습니다: {e}"))?;
    let logo = image::load_from_memory(&logo_bytes)
        .map_err(|e| format!("로고 이미지 디코딩에 실패했습니다: {e}"))?;
    let flattened = flatten_alpha_to_white(&logo);

    let mut png_bytes = Vec::new();
    DynamicImage::ImageRgb8(flattened)
        .write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
        .map_err(|e| format!("로고 이미지 변환에 실패했습니다: {e}"))?;

    Ok(png_bytes)
}

fn flatten_alpha_to_white(logo: &DynamicImage) -> ImageBuffer<Rgb<u8>, Vec<u8>> {
    let rgba = logo.to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut out = ImageBuffer::new(width, height);

    for (x, y, px) in rgba.enumerate_pixels() {
        let a = f32::from(px[3]) / 255.0;
        let r = ((f32::from(px[0]) * a) + (255.0 * (1.0 - a))).round() as u8;
        let g = ((f32::from(px[1]) * a) + (255.0 * (1.0 - a))).round() as u8;
        let b = ((f32::from(px[2]) * a) + (255.0 * (1.0 - a))).round() as u8;
        out.put_pixel(x, y, Rgb([r, g, b]));
    }

    out
}

fn compute_logo_rect(
    page_width: f64,
    page_height: f64,
    settings: &StampSettings,
    logo_stream: &[u8],
) -> Result<(f64, f64, f64, f64), String> {
    if page_width <= 0.0 || page_height <= 0.0 {
        return Err("페이지 크기가 유효하지 않습니다.".to_string());
    }

    let logo = image::load_from_memory(logo_stream)
        .map_err(|e| format!("로고 크기 계산에 실패했습니다: {e}"))?;
    let (logo_w, logo_h) = logo.dimensions();
    if logo_w == 0 || logo_h == 0 {
        return Err("로고 크기가 유효하지 않습니다.".to_string());
    }

    let short_side = page_width.min(page_height);
    let margin = short_side * settings.margin_percent / 100.0;
    let target_max = (short_side * settings.size_ratio).max(1.0);
    let logo_max = f64::from(logo_w.max(logo_h));
    let scale = target_max / logo_max;

    let draw_width = (f64::from(logo_w) * scale).max(1.0);
    let draw_height = (f64::from(logo_h) * scale).max(1.0);

    let max_x = (page_width - draw_width).max(0.0);
    let max_y = (page_height - draw_height).max(0.0);

    let left_x = margin.min(max_x);
    let right_x = (page_width - draw_width - margin).max(0.0).min(max_x);
    let bottom_y = margin.min(max_y);
    let top_y = (page_height - draw_height - margin).max(0.0).min(max_y);

    let (x, y) = match settings.position {
        CornerPosition::TopLeft => (left_x, top_y),
        CornerPosition::TopRight => (right_x, top_y),
        CornerPosition::BottomLeft => (left_x, bottom_y),
        CornerPosition::BottomRight => (right_x, bottom_y),
    };

    Ok((x, y, draw_width, draw_height))
}

fn resolve_page_size(
    doc: &Document,
    page_id: ObjectId,
    page_number: u32,
) -> Result<(f64, f64), String> {
    let mut current_id = page_id;

    for _ in 0..32 {
        let dict = get_object_dictionary(doc, current_id)
            .map_err(|e| format!("페이지 {page_number} 객체를 읽지 못했습니다: {e}"))?;

        if let Ok(media_box) = dict.get(b"MediaBox") {
            return parse_media_box(doc, media_box)
                .map_err(|e| format!("페이지 {page_number} MediaBox를 해석하지 못했습니다: {e}"));
        }

        let parent = match dict.get(b"Parent") {
            Ok(Object::Reference(parent_id)) => *parent_id,
            _ => break,
        };
        current_id = parent;
    }

    Err(format!(
        "페이지 {page_number}의 MediaBox를 찾지 못했습니다."
    ))
}

fn get_object_dictionary<'a>(
    doc: &'a Document,
    object_id: ObjectId,
) -> Result<&'a Dictionary, String> {
    let object = doc
        .get_object(object_id)
        .map_err(|e| format!("객체 조회 실패({object_id:?}): {e}"))?;

    match object {
        Object::Dictionary(dict) => Ok(dict),
        Object::Stream(stream) => Ok(&stream.dict),
        _ => Err("페이지 객체가 Dictionary/Stream이 아닙니다.".to_string()),
    }
}

fn parse_media_box(doc: &Document, obj: &Object) -> Result<(f64, f64), String> {
    let arr_ref = match obj {
        Object::Array(arr) => arr,
        Object::Reference(object_id) => doc
            .get_object(*object_id)
            .map_err(|e| format!("MediaBox 참조 객체 조회 실패({object_id:?}): {e}"))?
            .as_array()
            .map_err(|_| "MediaBox 참조 객체가 배열이 아닙니다.".to_string())?,
        _ => return Err("MediaBox는 배열이어야 합니다.".to_string()),
    };

    let arr = arr_ref;

    if arr.len() != 4 {
        return Err("MediaBox 길이가 4가 아닙니다.".to_string());
    }

    let llx = object_to_f64(&arr[0])?;
    let lly = object_to_f64(&arr[1])?;
    let urx = object_to_f64(&arr[2])?;
    let ury = object_to_f64(&arr[3])?;
    let width = urx - llx;
    let height = ury - lly;

    if width <= 0.0 || height <= 0.0 {
        return Err("MediaBox 너비/높이가 0 이하입니다.".to_string());
    }

    Ok((width, height))
}

fn object_to_f64(obj: &Object) -> Result<f64, String> {
    match obj {
        Object::Integer(v) => Ok(*v as f64),
        Object::Real(v) => Ok((*v).into()),
        _ => Err("MediaBox 좌표가 숫자가 아닙니다.".to_string()),
    }
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
    use image::RgbaImage;
    use lopdf::{dictionary, Stream};
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

    fn write_minimal_two_page_pdf(path: &Path) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let page1_id = doc.new_object_id();
        let page2_id = doc.new_object_id();
        let content1_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
        let content2_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));

        let media_box = vec![0.into(), 0.into(), 300.into(), 300.into()];

        doc.objects.insert(
            page1_id,
            Object::Dictionary(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => media_box.clone(),
                "Contents" => content1_id,
                "Resources" => dictionary! {},
            }),
        );
        doc.objects.insert(
            page2_id,
            Object::Dictionary(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => media_box.clone(),
                "Contents" => content2_id,
                "Resources" => dictionary! {},
            }),
        );

        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page1_id.into(), page2_id.into()],
                "Count" => 2,
                "MediaBox" => media_box,
            }),
        );

        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        doc.compress();
        doc.save(path).expect("write pdf fixture");
    }

    #[test]
    fn stamp_pdfs_stamps_all_pages_of_two_page_pdf() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("cornerbrand-pdf-engine-{nonce}"));
        fs::create_dir_all(&root).expect("temp dir");

        let input_pdf = root.join("input.pdf");
        let logo_path = root.join("logo.png");
        write_minimal_two_page_pdf(&input_pdf);
        write_test_png(&logo_path, 8, 8, [255, 0, 0, 255]);

        let settings = StampSettingsInput {
            position: "우하단".to_string(),
            size_preset: "보통".to_string(),
            size_percent: None,
            margin_percent: 2.0,
        };

        let paths = vec![input_pdf.to_string_lossy().to_string()];
        let results = stamp_pdfs(&paths, settings, &logo_path, None);

        assert_eq!(results.len(), 1);
        assert!(results[0].ok, "expected success: {:?}", results[0].error);

        let output_path = PathBuf::from(results[0].output_path.as_ref().expect("output path"));
        assert!(output_path.exists(), "stamped pdf should exist");

        let output_doc = Document::load(&output_path).expect("load output pdf");
        assert_eq!(
            output_doc.get_pages().len(),
            2,
            "output should keep 2 pages"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
