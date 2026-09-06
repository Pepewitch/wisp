//! The pure half of task notifications: what native code accepts from the
//! webview before it reaches UNUserNotificationCenter. The framework half
//! needs a bundled Wisp.app and a person to click, so it is exercised by the
//! packaged build, not here.

use wisp_desktop::notifications::{
    is_valid_task_id, FocusRequest, NotifyError, TaskNotification, FOCUS_TASK_EVENT,
};

fn notification() -> TaskNotification {
    TaskNotification {
        connection_id: "c-0123456789ab".to_string(),
        task_id: "tabcde".to_string(),
        title: "  Fix the flaky test  ".to_string(),
        body: " Needs input · Local ".to_string(),
    }
}

#[test]
fn trims_text_and_keeps_ids() {
    let validated = notification().validated().expect("valid");
    assert_eq!(validated.connection_id, "c-0123456789ab");
    assert_eq!(validated.task_id, "tabcde");
    assert_eq!(validated.title, "Fix the flaky test");
    assert_eq!(validated.body, "Needs input · Local");
    assert_eq!(validated.identifier(), "c-0123456789ab:tabcde");
    assert_eq!(
        validated.focus_request(),
        FocusRequest {
            connection_id: "c-0123456789ab".to_string(),
            task_id: "tabcde".to_string(),
        }
    );
}

#[test]
fn bounds_long_text_on_character_boundaries() {
    let long_title = "é".repeat(500);
    let validated = TaskNotification {
        title: long_title,
        body: "x".repeat(1_000),
        ..notification()
    }
    .validated()
    .expect("valid");
    assert_eq!(validated.title.chars().count(), 120);
    assert!(validated.title.ends_with('…'));
    assert_eq!(validated.body.chars().count(), 200);
    assert!(validated.body.ends_with('…'));
}

#[test]
fn refuses_ids_that_could_not_route_and_titles_that_say_nothing() {
    assert_eq!(
        TaskNotification {
            connection_id: "../local".to_string(),
            ..notification()
        }
        .validated(),
        Err(NotifyError::InvalidConnectionId)
    );
    assert_eq!(
        TaskNotification {
            task_id: "t 1".to_string(),
            ..notification()
        }
        .validated(),
        Err(NotifyError::InvalidTaskId)
    );
    assert_eq!(
        TaskNotification {
            title: "   ".to_string(),
            ..notification()
        }
        .validated(),
        Err(NotifyError::EmptyTitle)
    );
    assert!(is_valid_task_id("t2345"));
    assert!(is_valid_task_id("task_id-1"));
    assert!(!is_valid_task_id(""));
    assert!(!is_valid_task_id(&"a".repeat(129)));
    assert!(!is_valid_task_id("t/1"));
}

#[test]
fn serializes_for_the_webview_in_camel_case() {
    let request = notification().validated().expect("valid").focus_request();
    let json = serde_json::to_value(&request).expect("json");
    assert_eq!(
        json,
        serde_json::json!({ "connectionId": "c-0123456789ab", "taskId": "tabcde" })
    );
    let parsed: TaskNotification = serde_json::from_value(serde_json::json!({
        "connectionId": "local",
        "taskId": "t1",
        "title": "Done",
        "body": "Done · Local",
    }))
    .expect("camelCase input");
    assert_eq!(parsed.connection_id, "local");
    assert_eq!(FOCUS_TASK_EVENT, "desktop://focus-task");
}

#[test]
fn a_bare_test_binary_has_no_notification_center() {
    // `cargo test` runs an unbundled executable, exactly like `tauri dev`; the
    // command must answer with an error rather than reaching the framework.
    assert!(!wisp_desktop::notifications::available());
    assert_eq!(
        wisp_desktop::notifications::deliver(&notification().validated().expect("valid")),
        Err(NotifyError::Unavailable)
    );
}
