#import "automation.h"
id KCUADispatch(NSString *method, NSDictionary *params, const KCUAOp &op) {
  (void)params;
  KCUACheck(op);
  if ([method isEqual:@"permission_status"] ||
      [method isEqual:@"request_access"])
    return KCUAPermissionStatus();
  if ([method isEqual:@"supports_accessibility"])
    return @YES;
  if ([method isEqual:@"input_permission_status"])
    return @{@"accessibility" : KCUAPermissionStatus()[@"accessibility"]};
  if ([method isEqual:@"screen_capture_status"])
    return @{@"screen_recording" : KCUAPermissionStatus()[@"screen_recording"]};
  if ([method isEqual:@"screen_capture_probe"]) {
    @try {
      KCUARequireDesktop();
      NSRunningApplication *front =
          NSWorkspace.sharedWorkspace.frontmostApplication;
      if (!front || front.processIdentifier == getpid())
        return @{@"ok" : @NO, @"classification" : @"no_target_window"};
      auto target = KCUAResolveTarget(
          @{@"pid" : @(front.processIdentifier)}, op, false);
      NSDictionary *capture = KCUACapture(target, op);
      bool valid = ![capture[@"screenshot_blank"] boolValue];
      return @{
        @"ok" : @(valid),
        @"classification" : valid ? @"ready" : @"uniform_frame"
      };
    } @catch (NSException *error) {
      if ([error.name isEqual:@"cleanup_incomplete"] ||
          [error.name isEqual:@"cancelled"])
        @throw;
      return @{@"ok" : @NO, @"classification" : error.name};
    }
  }
  if ([method isEqual:@"controller_takeover"]) {
    KCUAAcquireLease();
    return KCUALeaseStatus();
  }
  if ([method isEqual:@"controller_stop"]) {
    KCUAReleaseLease();
    return @{@"stopped" : @YES};
  }
  if ([@[
        @"list_applications", @"application_info", @"list_windows",
        @"capture_app", @"element_at_point", @"read_element"
      ] containsObject:method])
    return KCUAObservation(method, params, op);
  if ([@[
        @"prevent_activation",
        @"reenable_activation",
        @"is_focus_steal_prevented",
        @"click",
        @"scroll",
        @"drag",
        @"type_text",
        @"type_text_to_app",
        @"press_key",
        @"press_key_to_app",
        @"hold_key",
        @"hold_key_to_app",
        @"cancel_input_holds",
        @"element_press",
        @"element_show_menu",
        @"element_focus",
        @"element_set_value",
        @"element_perform_action",
        @"element_select_text",
        @"element_scroll",
        @"paste"
      ] containsObject:method])
    return KCUAInput(method, params, op);
  if ([method hasPrefix:@"pip_"])
    return KCUAPresentation(method, params, op);
  KCUAFail(
      @"method_not_found",
      [NSString stringWithFormat:@"Unsupported CUA broker method: %@", method]);
}
void KCUACleanup(const KCUAOp &op) { KCUAInputCleanup(op); }
