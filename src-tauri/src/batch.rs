use crate::image_engine::{self, StampFileResult, StampSettingsInput};
use crate::path_policy;
use crate::pdf_engine;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static CANCELLATION_REGISTRY: OnceLock<Mutex<BTreeMap<String, bool>>> = OnceLock::new();

pub struct BatchRequestGuard {
    request_id: String,
}

impl Drop for BatchRequestGuard {
    fn drop(&mut self) {
        clear_cancellation_request(&self.request_id);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchReport {
    timestamp: u64,
    settings: StampSettingsInput,
    results: Vec<StampFileResult>,
}

#[derive(Debug, Clone)]
pub struct ProgressUpdate {
    pub total: usize,
    pub done: usize,
    pub input_path: String,
    pub ok: bool,
}

pub fn stamp_batch(
    paths: &[String],
    settings: StampSettingsInput,
    logo_path: &Path,
    output_base_dir: Option<&Path>,
) -> Vec<StampFileResult> {
    stamp_batch_with_progress(
        paths,
        settings,
        logo_path,
        output_base_dir,
        None,
        &mut |_| {},
        None,
    )
}

pub fn stamp_batch_with_progress(
    paths: &[String],
    settings: StampSettingsInput,
    logo_path: &Path,
    output_base_dir: Option<&Path>,
    request_id: Option<&str>,
    on_progress: &mut dyn FnMut(ProgressUpdate),
    size_percent_by_path: Option<&BTreeMap<String, f32>>,
) -> Vec<StampFileResult> {
    let total = paths.len();
    let mut results = Vec::with_capacity(total);

    for (index, input) in paths.iter().enumerate() {
        if let Some(request_id) = request_id {
            if is_request_cancelled(request_id) {
                for cancelled_input in &paths[index..] {
                    results.push(cancelled_result(cancelled_input.clone()));
                }
                break;
            }
        }

        let mut settings_for_input = settings.clone();
        if let Some(size_percent_by_path) = size_percent_by_path {
            if let Some(size_percent) = size_percent_by_path.get(input) {
                settings_for_input.size_percent = Some(size_percent.clamp(1.0, 300.0));
            }
        }

        let input_path = Path::new(input);
        let result = if path_policy::detect_supported_image(input_path).is_some() {
            image_engine::stamp_images(
                std::slice::from_ref(input),
                settings_for_input.clone(),
                logo_path,
                output_base_dir,
            )
            .into_iter()
            .next()
            .unwrap_or_else(|| unsupported_type_result(input.clone()))
        } else if path_policy::is_supported_pdf(input_path) {
            pdf_engine::stamp_pdfs(
                std::slice::from_ref(input),
                settings_for_input.clone(),
                logo_path,
                output_base_dir,
            )
            .into_iter()
            .next()
            .unwrap_or_else(|| unsupported_type_result(input.clone()))
        } else {
            unsupported_type_result(input.clone())
        };

        on_progress(ProgressUpdate {
            total,
            done: index + 1,
            input_path: input.clone(),
            ok: result.ok,
        });

        results.push(result);
    }

    write_reports(settings, &results, output_base_dir);
    results
}

fn unsupported_type_result(input_path: String) -> StampFileResult {
    StampFileResult {
        input_path,
        ok: false,
        output_path: None,
        error: Some("지원하지 않는 파일 형식입니다. (jpg/jpeg/png/webp/pdf)".to_string()),
    }
}

fn cancelled_result(input_path: String) -> StampFileResult {
    StampFileResult {
        input_path,
        ok: false,
        output_path: None,
        error: Some("취소됨".to_string()),
    }
}

fn cancellation_registry() -> &'static Mutex<BTreeMap<String, bool>> {
    CANCELLATION_REGISTRY.get_or_init(|| Mutex::new(BTreeMap::new()))
}

pub fn begin_cancellation_request(request_id: &str) -> BatchRequestGuard {
    if let Ok(mut registry) = cancellation_registry().lock() {
        registry.insert(request_id.to_string(), false);
    }

    BatchRequestGuard {
        request_id: request_id.to_string(),
    }
}

pub fn cancel_cancellation_request(request_id: &str) -> bool {
    if let Ok(mut registry) = cancellation_registry().lock() {
        if let Some(cancelled) = registry.get_mut(request_id) {
            *cancelled = true;
            return true;
        }
    }

    false
}

fn clear_cancellation_request(request_id: &str) {
    if let Ok(mut registry) = cancellation_registry().lock() {
        registry.remove(request_id);
    }
}

fn is_request_cancelled(request_id: &str) -> bool {
    if let Ok(registry) = cancellation_registry().lock() {
        return registry.get(request_id).copied().unwrap_or(false);
    }

    false
}

fn write_reports(
    settings: StampSettingsInput,
    results: &[StampFileResult],
    output_base_dir: Option<&Path>,
) {
    if let Some(output_base_dir) = output_base_dir {
        let report_path =
            match path_policy::build_report_path(output_base_dir, Some(output_base_dir)) {
                Ok(path) => path,
                Err(_) => return,
            };

        write_report_file(settings, results.to_vec(), report_path);
        return;
    }

    let mut grouped = BTreeMap::<PathBuf, Vec<StampFileResult>>::new();

    for result in results {
        let input_path = Path::new(&result.input_path);
        let parent = match input_path.parent() {
            Some(parent) => parent.to_path_buf(),
            None => continue,
        };

        grouped.entry(parent).or_default().push(result.clone());
    }

    for (parent_dir, group_results) in grouped {
        let report_path = match path_policy::build_report_path(&parent_dir, None) {
            Ok(path) => path,
            Err(_) => continue,
        };

        write_report_file(settings.clone(), group_results, report_path);
    }
}

fn write_report_file(
    settings: StampSettingsInput,
    results: Vec<StampFileResult>,
    report_path: PathBuf,
) {
    let report = BatchReport {
        timestamp: unix_timestamp_seconds(),
        settings,
        results,
    };

    let payload = match serde_json::to_vec_pretty(&report) {
        Ok(content) => content,
        Err(_) => return,
    };

    let _ = std::fs::write(report_path, payload);
}

fn unix_timestamp_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbaImage;
    use lopdf::{dictionary, Document, Object, Stream};
    use serde_json::Value;
    use std::fs;
    use std::path::Path;
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

    fn count_non_background_pixels(path: &Path, background: [u8; 4]) -> usize {
        image::open(path)
            .expect("open output image")
            .to_rgba8()
            .pixels()
            .filter(|pixel| pixel.0 != background)
            .count()
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
    fn stamp_batch_writes_report_for_png_and_pdf_inputs() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("cornerbrand-batch-{nonce}"));
        fs::create_dir_all(&root).expect("temp dir");

        let input_png = root.join("input.png");
        let input_pdf = root.join("input.pdf");
        let logo_png = root.join("logo.png");

        write_test_png(&input_png, 32, 32, [200, 200, 200, 255]);
        write_minimal_two_page_pdf(&input_pdf);
        write_test_png(&logo_png, 8, 8, [255, 0, 0, 255]);

        let settings = StampSettingsInput {
            position: "우하단".to_string(),
            size_preset: "보통".to_string(),
            size_percent: None,
            margin_percent: 2.0,
        };

        let paths = vec![
            input_png.to_string_lossy().to_string(),
            input_pdf.to_string_lossy().to_string(),
        ];
        let results = stamp_batch(&paths, settings, &logo_png, None);

        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.ok), "expected all success");

        let report_path = root
            .join(path_policy::OUTPUT_DIR_NAME)
            .join("cornerbrand_report.json");
        assert!(report_path.exists(), "batch report should exist");

        let report_text = fs::read_to_string(&report_path).expect("read batch report");
        let report_json: Value =
            serde_json::from_str(&report_text).expect("parse batch report json");
        let result_count = report_json
            .get("results")
            .and_then(|v| v.as_array())
            .map(|arr| arr.len())
            .unwrap_or(0);
        assert_eq!(result_count, 2, "report should include both results");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stamp_batch_writes_single_report_to_output_override_dir() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("cornerbrand-batch-override-{nonce}"));
        let input_dir_a = root.join("a");
        let input_dir_b = root.join("b");
        let output_override = root.join("exports");
        fs::create_dir_all(&input_dir_a).expect("input dir a");
        fs::create_dir_all(&input_dir_b).expect("input dir b");

        let input_png = input_dir_a.join("input.png");
        let input_pdf = input_dir_b.join("input.pdf");
        let logo_png = root.join("logo.png");

        write_test_png(&input_png, 32, 32, [200, 200, 200, 255]);
        write_minimal_two_page_pdf(&input_pdf);
        write_test_png(&logo_png, 8, 8, [255, 0, 0, 255]);

        let settings = StampSettingsInput {
            position: "우하단".to_string(),
            size_preset: "보통".to_string(),
            size_percent: None,
            margin_percent: 2.0,
        };

        let paths = vec![
            input_png.to_string_lossy().to_string(),
            input_pdf.to_string_lossy().to_string(),
        ];
        let results = stamp_batch(&paths, settings, &logo_png, Some(&output_override));

        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.ok), "expected all success");

        let output_root = output_override.join(path_policy::OUTPUT_DIR_NAME);
        assert!(output_root.exists(), "override output dir should exist");

        for result in &results {
            let output = PathBuf::from(result.output_path.as_ref().expect("output path"));
            assert!(
                output.starts_with(&output_root),
                "output should be written to override output dir"
            );
        }

        let override_report = output_root.join("cornerbrand_report.json");
        assert!(override_report.exists(), "override report should exist");
        assert!(
            !input_dir_a
                .join(path_policy::OUTPUT_DIR_NAME)
                .join("cornerbrand_report.json")
                .exists(),
            "input A parent should not get report when override is set"
        );
        assert!(
            !input_dir_b
                .join(path_policy::OUTPUT_DIR_NAME)
                .join("cornerbrand_report.json")
                .exists(),
            "input B parent should not get report when override is set"
        );

        let report_text = fs::read_to_string(&override_report).expect("read batch report");
        let report_json: Value =
            serde_json::from_str(&report_text).expect("parse batch report json");
        let result_count = report_json
            .get("results")
            .and_then(|v| v.as_array())
            .map(|arr| arr.len())
            .unwrap_or(0);
        assert_eq!(result_count, 2, "report should include both results");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stamp_batch_with_progress_marks_remaining_files_cancelled() {
        let request_id = "cancel-test-request";
        let _guard = begin_cancellation_request(request_id);
        assert!(cancel_cancellation_request(request_id));

        let settings = StampSettingsInput {
            position: "우하단".to_string(),
            size_preset: "보통".to_string(),
            size_percent: None,
            margin_percent: 2.0,
        };

        let paths = vec![
            "first.unsupported".to_string(),
            "second.unsupported".to_string(),
        ];

        let mut progress_events = 0usize;
        let results = stamp_batch_with_progress(
            &paths,
            settings,
            Path::new("logo.png"),
            None,
            Some(request_id),
            &mut |_| {
                progress_events += 1;
            },
            None,
        );

        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|result| !result.ok));
        assert!(results
            .iter()
            .all(|result| result.error.as_deref() == Some("취소됨")));
        assert_eq!(progress_events, 0);
    }

    #[test]
    fn stamp_batch_with_progress_applies_size_override_per_path() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("cornerbrand-batch-size-map-{nonce}"));
        fs::create_dir_all(&root).expect("temp dir");

        let input_a = root.join("input-a.png");
        let input_b = root.join("input-b.png");
        let logo_png = root.join("logo.png");

        write_test_png(&input_a, 100, 100, [200, 200, 200, 255]);
        write_test_png(&input_b, 100, 100, [200, 200, 200, 255]);
        write_test_png(&logo_png, 10, 10, [255, 0, 0, 255]);

        let settings = StampSettingsInput {
            position: "우하단".to_string(),
            size_preset: "보통".to_string(),
            size_percent: None,
            margin_percent: 0.0,
        };

        let input_a_string = input_a.to_string_lossy().to_string();
        let input_b_string = input_b.to_string_lossy().to_string();
        let paths = vec![input_a_string.clone(), input_b_string.clone()];

        let mut size_percent_by_path = BTreeMap::new();
        size_percent_by_path.insert(input_b_string, 40.0);

        let results = stamp_batch_with_progress(
            &paths,
            settings,
            &logo_png,
            None,
            None,
            &mut |_| {},
            Some(&size_percent_by_path),
        );

        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.ok), "expected all success");

        let output_a = PathBuf::from(results[0].output_path.as_ref().expect("output path a"));
        let output_b = PathBuf::from(results[1].output_path.as_ref().expect("output path b"));

        let changed_pixels_a = count_non_background_pixels(&output_a, [200, 200, 200, 255]);
        let changed_pixels_b = count_non_background_pixels(&output_b, [200, 200, 200, 255]);

        assert!(changed_pixels_a > 0, "first file should be stamped");
        assert!(
            changed_pixels_b > changed_pixels_a * 3,
            "override file should have a much larger logo area"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stamp_batch_with_progress_clamps_size_override_to_300() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("cornerbrand-batch-size-clamp-{nonce}"));
        fs::create_dir_all(&root).expect("temp dir");

        let input_a = root.join("input-a.png");
        let input_b = root.join("input-b.png");
        let logo_png = root.join("logo.png");

        write_test_png(&input_a, 100, 100, [200, 200, 200, 255]);
        write_test_png(&input_b, 100, 100, [200, 200, 200, 255]);
        write_test_png(&logo_png, 10, 10, [255, 0, 0, 255]);

        let settings = StampSettingsInput {
            position: "우하단".to_string(),
            size_preset: "보통".to_string(),
            size_percent: None,
            margin_percent: 0.0,
        };

        let input_a_string = input_a.to_string_lossy().to_string();
        let input_b_string = input_b.to_string_lossy().to_string();
        let paths = vec![input_a_string.clone(), input_b_string.clone()];

        let mut size_percent_by_path = BTreeMap::new();
        size_percent_by_path.insert(input_a_string, 300.0);
        size_percent_by_path.insert(input_b_string, 1000.0);

        let results = stamp_batch_with_progress(
            &paths,
            settings,
            &logo_png,
            None,
            None,
            &mut |_| {},
            Some(&size_percent_by_path),
        );

        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.ok), "expected all success");

        let output_a = PathBuf::from(results[0].output_path.as_ref().expect("output path a"));
        let output_b = PathBuf::from(results[1].output_path.as_ref().expect("output path b"));

        let changed_pixels_a = count_non_background_pixels(&output_a, [200, 200, 200, 255]);
        let changed_pixels_b = count_non_background_pixels(&output_b, [200, 200, 200, 255]);

        assert_eq!(
            changed_pixels_a, changed_pixels_b,
            "1000% override should clamp to the 300% output"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
