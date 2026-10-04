//! Text typed into the shell's webview arrives exactly as typed.
//!
//! WebKit follows the macOS keyboard setting "Use smart quotes and dashes", so
//! with it on, `--force` typed into the composer reaches the agent as
//! `—force`. Prompts are full of flags and code, and the browser build is not
//! affected, so the shell turns dash substitution off for this app only.
//!
//! This registers a fallback rather than writing a preference: nothing is
//! stored, and an explicit `defaults write <bundle id>
//! WebAutomaticDashSubstitutionEnabled -bool true` still wins.

use objc2::runtime::AnyObject;
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSUserDefaults};

/// The user default WebKit reads before falling back to the system setting.
const DASH_SUBSTITUTION: &str = "WebAutomaticDashSubstitutionEnabled";

/// Turn off smart dashes. WebKit reads the setting once, when the first
/// webview is created, so this must run before the window is built.
pub fn disable_smart_dashes() {
    let key = NSString::from_str(DASH_SUBSTITUTION);
    let off = NSNumber::new_bool(false);
    let value: &AnyObject = &off;
    let defaults = NSDictionary::from_slices(&[&*key], &[value]);
    // SAFETY: the dictionary maps an NSString key to an NSNumber, the types
    // `registerDefaults:` requires of a property-list value.
    unsafe { NSUserDefaults::standardUserDefaults().registerDefaults(&defaults) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dash_substitution_is_off_after_registration() {
        disable_smart_dashes();
        let key = NSString::from_str(DASH_SUBSTITUTION);
        let defaults = NSUserDefaults::standardUserDefaults();
        assert!(defaults.objectForKey(&key).is_some());
        assert!(!defaults.boolForKey(&key));
    }
}
