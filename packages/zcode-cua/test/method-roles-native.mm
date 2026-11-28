#import "../native/macos/protocol.h"
#include <cassert>
int main(void) {
  @autoreleasepool {
    for (NSString *method in @[
           @"pip_session_handshake", @"pip_session_event", @"pip_start",
           @"pip_stop", @"pip_clear_dismissed"
         ])
      assert(KCUARequiresPresentation(method) &&
             "a method that changes the panel needs the presentation capability");
    for (NSString *method in @[
           @"pip_is_running", @"capture_app", @"click", @"type_text_to_app",
           @"list_windows", @"request_access", @"session_release",
           @"operation_cancel", @"authenticate", @"broker_info", @"pip_", @""
         ])
      assert(!KCUARequiresPresentation(method) &&
             "tool methods and status queries stay on the tool authority");
    puts("presentation role table regressions passed");
  }
}
