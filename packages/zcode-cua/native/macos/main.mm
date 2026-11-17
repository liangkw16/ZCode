#import <Cocoa/Cocoa.h>
#include <cstdio>
#include <cstring>

#ifndef KCODE_BUILD_ID
#error Native build must provide a source-derived build ID
#endif

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc > 1 && strcmp(argv[1], "--version") == 0) {
      NSDictionary *version = @{@"producer": @"kcode-cua-source", @"protocol": @3,
        @"buildId": @KCODE_BUILD_ID, @"bundleId": @"dev.zcode.cua-helper.kcode"};
      NSData *data = [NSJSONSerialization dataWithJSONObject:version options:0 error:nil];
      fwrite(data.bytes, 1, data.length, stdout);
      fputc('\n', stdout);
      return 0;
    }
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [app run];
  }
  return 0;
}
