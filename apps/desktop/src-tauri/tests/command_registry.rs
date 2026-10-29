//! A new command either enters the one shared dispatcher or fails CI.
use std::{fs, path::Path};

#[test]
fn every_app_command_is_in_the_shared_registry() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let lib = fs::read_to_string(root.join("lib.rs")).unwrap();
    assert_eq!(lib.matches("tauri::generate_handler![").count(), 1);
    let registry = lib
        .split("tauri::generate_handler![")
        .nth(1)
        .unwrap()
        .split("])")
        .next()
        .unwrap();
    fn check(dir: &Path, registry: &str, count: &mut usize) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                check(&path, registry, count);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let source = fs::read_to_string(&path).unwrap();
                for command in source.split("#[tauri::command").skip(1) {
                    let name = command
                        .split("fn ")
                        .nth(1)
                        .unwrap()
                        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                        .next()
                        .unwrap();
                    assert!(
                        registry.contains(&format!("::{name},")),
                        "{}: {name} missing from shared generate_handler!",
                        path.display()
                    );
                    *count += 1;
                }
            }
        }
    }
    let mut count = 0;
    check(&root, registry, &mut count);
    assert!(count >= 20);
}
