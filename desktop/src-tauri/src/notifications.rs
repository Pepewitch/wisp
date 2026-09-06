//! macOS task notifications through Apple's UNUserNotificationCenter.
//!
//! The shared React app decides *when* a task deserves a banner — a running
//! turn that reached done, needs-input, failed, or stuck — because it already
//! holds every connection's task list. Native code owns the two things a
//! webview cannot do: post a notification, and learn that the person clicked
//! it. A click becomes one [`FOCUS_TASK_EVENT`] carrying the connection and
//! task IDs, and the main window is brought to the front.
//!
//! Why not `tauri-plugin-notification`: on desktop it wraps `notify-rust`,
//! which can show a banner but never reports the click, and a banner that
//! cannot open the task it names is only half the feature.
//!
//! UNUserNotificationCenter needs a bundle identifier. A bare `tauri dev`
//! binary has none and the framework aborts the process when asked, so every
//! entry point checks [`available`] first and the command returns a plain
//! error instead.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Event the webview listens on; the payload is a [`FocusRequest`].
pub const FOCUS_TASK_EVENT: &str = "desktop://focus-task";
/// The window label in `tauri.conf.json`.
pub const MAIN_WINDOW_LABEL: &str = "main";

const TITLE_LIMIT: usize = 120;
const BODY_LIMIT: usize = 200;
const TASK_ID_LIMIT: usize = 128;

/// One finished task, already worded by the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskNotification {
    pub connection_id: String,
    pub task_id: String,
    pub title: String,
    pub body: String,
}

/// What a click asks the webview to show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusRequest {
    pub connection_id: String,
    pub task_id: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum NotifyError {
    #[error("a task notification needs a valid connection id")]
    InvalidConnectionId,
    #[error("a task notification needs a valid task id")]
    InvalidTaskId,
    #[error("a task notification needs a title")]
    EmptyTitle,
    #[error(
        "task notifications need the packaged Wisp.app; this process has no bundle identifier"
    )]
    Unavailable,
}

/// Task IDs travel back on a click and become routing input, so the same
/// alphabet rule as connection IDs applies, with a generous length bound.
pub fn is_valid_task_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= TASK_ID_LIMIT
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Trim, then cut on a character boundary with an ellipsis. Notification
/// Center truncates on its own, but the request should not carry a novel.
fn bounded(text: &str, limit: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit.saturating_sub(1)).collect();
    out.push('…');
    out
}

impl TaskNotification {
    /// The shape native code is willing to hand to the framework.
    pub fn validated(self) -> Result<Self, NotifyError> {
        if !crate::registry::is_valid_connection_id(&self.connection_id) {
            return Err(NotifyError::InvalidConnectionId);
        }
        if !is_valid_task_id(&self.task_id) {
            return Err(NotifyError::InvalidTaskId);
        }
        let title = bounded(&self.title, TITLE_LIMIT);
        if title.is_empty() {
            return Err(NotifyError::EmptyTitle);
        }
        Ok(Self {
            connection_id: self.connection_id,
            task_id: self.task_id,
            title,
            body: bounded(&self.body, BODY_LIMIT),
        })
    }

    /// One notification per task: a later state for the same task replaces
    /// the earlier banner instead of stacking under it.
    pub fn identifier(&self) -> String {
        format!("{}:{}", self.connection_id, self.task_id)
    }

    pub fn focus_request(&self) -> FocusRequest {
        FocusRequest {
            connection_id: self.connection_id.clone(),
            task_id: self.task_id.clone(),
        }
    }
}

/// Whether this process may talk to UNUserNotificationCenter at all.
pub fn available() -> bool {
    platform::has_bundle_identifier()
}

/// Become the notification center's delegate. Call once, on the main thread,
/// before the first [`deliver`]. Returns false when notifications are off for
/// this process (no bundle), which is the normal `tauri dev` case.
pub fn install(app: AppHandle) -> bool {
    if !available() {
        return false;
    }
    platform::install_delegate(app);
    true
}

/// Post the notification, asking for permission first if macOS has not
/// decided yet. The request is queued inside the permission callback so the
/// very first banner is not lost to the prompt.
pub fn deliver(notification: &TaskNotification) -> Result<(), NotifyError> {
    if !available() {
        return Err(NotifyError::Unavailable);
    }
    platform::post(notification);
    Ok(())
}

mod platform {
    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread, DefinedClass};
    use objc2_foundation::{NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNNotificationSound,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use tauri::{AppHandle, Emitter, Manager};

    use super::{FocusRequest, TaskNotification, FOCUS_TASK_EVENT, MAIN_WINDOW_LABEL};

    const CONNECTION_KEY: &str = "connectionId";
    const TASK_KEY: &str = "taskId";

    pub(super) fn has_bundle_identifier() -> bool {
        NSBundle::mainBundle().bundleIdentifier().is_some()
    }

    struct Ivars {
        app: AppHandle,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements and the delegate
        // does not implement Drop. The framework may call it from any thread,
        // and everything it touches (the Tauri handle) is thread-safe.
        #[unsafe(super(NSObject))]
        #[name = "WispTaskNotificationDelegate"]
        #[ivars = Ivars]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                // The webview already suppresses the one noisy case (the task
                // is on screen in a focused window), so a foreground Wisp
                // still shows the banner for every other task and tab.
                completion.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &DynBlock<dyn Fn()>,
            ) {
                if let Some(request) = focus_request(response) {
                    focus(&self.ivars().app, request);
                }
                completion.call(());
            }
        }
    );

    pub(super) fn install_delegate(app: AppHandle) {
        let delegate = Delegate::alloc().set_ivars(Ivars { app });
        let delegate: Retained<Delegate> = unsafe { msg_send![super(delegate), init] };
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center holds its delegate weakly. This process has exactly one
        // delegate for its whole lifetime, so the strong reference is simply
        // never released.
        let _ = Retained::into_raw(delegate);
    }

    /// Only the default action (a click on the banner itself) opens a task.
    fn focus_request(response: &UNNotificationResponse) -> Option<FocusRequest> {
        let action = response.actionIdentifier();
        // SAFETY: a framework-provided constant string, valid for the process lifetime.
        let default_action: &NSString = unsafe { UNNotificationDefaultActionIdentifier };
        if !action.isEqualToString(default_action) {
            return None;
        }
        let info = response.notification().request().content().userInfo();
        Some(FocusRequest {
            connection_id: string_value(&info, CONNECTION_KEY)?,
            task_id: string_value(&info, TASK_KEY)?,
        })
    }

    fn string_value(info: &NSDictionary, key: &str) -> Option<String> {
        let key = NSString::from_str(key);
        let value: Retained<AnyObject> = info.objectForKey(&key)?;
        value
            .downcast::<NSString>()
            .ok()
            .map(|text| text.to_string())
    }

    fn focus(app: &AppHandle, request: FocusRequest) {
        // Routing first, so the webview is already moving while the window
        // comes forward. Window calls are safe from any thread; Tauri
        // dispatches them to the main thread itself.
        if let Err(error) = app.emit(FOCUS_TASK_EVENT, &request) {
            eprintln!("[wisp-desktop] could not relay a notification click: {error}");
        }
        if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }

    fn user_info(notification: &TaskNotification) -> Retained<NSDictionary> {
        let keys = [
            NSString::from_str(CONNECTION_KEY),
            NSString::from_str(TASK_KEY),
        ];
        let values = [
            NSString::from_str(&notification.connection_id),
            NSString::from_str(&notification.task_id),
        ];
        let typed: Retained<NSDictionary<NSString, NSString>> =
            NSDictionary::from_slices(&[&*keys[0], &*keys[1]], &[&*values[0], &*values[1]]);
        // SAFETY: NSDictionary<NSString, NSString> is an NSDictionary; only the
        // Rust-side generics are erased.
        unsafe { Retained::cast_unchecked(typed) }
    }

    pub(super) fn post(notification: &TaskNotification) {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&notification.title));
        content.setBody(&NSString::from_str(&notification.body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        // SAFETY: every key and value is an NSString, which is property-list safe.
        unsafe { content.setUserInfo(&user_info(notification)) };
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&notification.identifier()),
            &content,
            None,
        );

        let center = UNUserNotificationCenter::currentNotificationCenter();
        let center_for_add = center.clone();
        let on_permission = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            if !granted.as_bool() {
                eprintln!(
                    "[wisp-desktop] task notifications are not permitted: {}",
                    describe(error).unwrap_or_else(|| "denied in System Settings".to_string())
                );
                return;
            }
            let on_added = RcBlock::new(|error: *mut NSError| {
                if let Some(message) = describe(error) {
                    eprintln!("[wisp-desktop] could not post a task notification: {message}");
                }
            });
            center_for_add.addNotificationRequest_withCompletionHandler(&request, Some(&on_added));
        });
        // Already-decided permission answers immediately; only the first ever
        // notification shows the system prompt.
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &on_permission,
        );
    }

    fn describe(error: *mut NSError) -> Option<String> {
        // SAFETY: the framework passes either null or a valid NSError for the
        // duration of the callback.
        unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string())
    }
}
