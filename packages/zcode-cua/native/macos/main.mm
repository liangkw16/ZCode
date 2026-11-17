#import "protocol.h"
#import <ApplicationServices/ApplicationServices.h>
#include <cstdio>
#include <cstring>
#include <signal.h>
extern int KCUALifecycleGuard(NSString *);
extern int KCUAPrintProcessIdentity(pid_t);
extern int KCUAInspectSocketOwner(NSString *, NSString *);

#ifndef KCODE_BUILD_ID
#error Native build must provide a source-derived build ID
#endif

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc > 1 && strcmp(argv[1], "--version") == 0) {
      NSDictionary *version = @{
        @"producer" : @"kcode-cua-source",
        @"protocol" : @3,
        @"buildId" : @KCODE_BUILD_ID,
        @"bundleId" : @"dev.zcode.cua-helper.kcode"
      };
      NSData *data = [NSJSONSerialization dataWithJSONObject:version
                                                     options:0
                                                       error:nil];
      fwrite(data.bytes, 1, data.length, stdout);
      fputc('\n', stdout);
      return 0;
    }
    NSArray<NSString *> *earlyArgs = NSProcessInfo.processInfo.arguments;
    if (earlyArgs.count > 2 && [earlyArgs[1] isEqual:@"--lifecycle-guard"])
      return KCUALifecycleGuard(earlyArgs[2]);
    if (earlyArgs.count > 2 && [earlyArgs[1] isEqual:@"--process-identity"])
      return KCUAPrintProcessIdentity([earlyArgs[2] intValue]);
    if (earlyArgs.count > 3 && [earlyArgs[1] isEqual:@"--inspect-socket-owner"])
      return KCUAInspectSocketOwner(earlyArgs[2], earlyArgs[3]);
    if ([earlyArgs containsObject:@"--request-permission"]) {
      NSUInteger index = [earlyArgs indexOfObject:@"--request-permission"];
      NSString *kind = index + 1 < earlyArgs.count ? earlyArgs[index + 1] : nil;
      if ([kind isEqual:@"accessibility"]) {
        NSDictionary *prompt =
            @{(__bridge NSString *)kAXTrustedCheckOptionPrompt : @YES};
        AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)prompt);
      } else if ([kind isEqual:@"screen"])
        CGRequestScreenCaptureAccess();
      else
        return 2;
      return 0;
    }
    if ([earlyArgs containsObject:@"--permission-preflight"]) {
      NSDictionary *report = KCUAPermissionStatus();
      NSData *data = [NSJSONSerialization dataWithJSONObject:report
                                                     options:0
                                                       error:nil];
      NSUInteger index =
          [earlyArgs indexOfObject:@"--permission-preflight-result-file"];
      if (index != NSNotFound && index + 1 < earlyArgs.count) {
        NSString *resultPath = earlyArgs[index + 1];
        if (![data writeToFile:resultPath
                       options:NSDataWritingAtomic
                         error:nil])
          return 2;
      } else {
        fwrite(data.bytes, 1, data.length, stdout);
        fputc('\n', stdout);
      }
      return 0;
    }
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSArray<NSString *> *args = NSProcessInfo.processInfo.arguments;
    NSString * (^value)(NSString *) = ^NSString *(NSString *name) {
      NSUInteger index = [args indexOfObject:name];
      return index != NSNotFound && index + 1 < args.count ? args[index + 1]
                                                           : nil;
    };
    NSString *socket =
        value(@"--socket")
            ?: NSProcessInfo.processInfo
                   .environment[@"ZCODE_CUA_PERMISSION_BROKER_SOCKET"];
    NSString *runtime =
        value(@"--runtime-dir")
            ?: [NSString stringWithFormat:@"/tmp/zcode-cua-%u", getuid()];
    if (!socket) {
      fprintf(stderr, "KCode Computer Use requires --socket <private path>\n");
      return 2;
    }
    KCUAPresentationInitialize([args containsObject:@"--pip-mode"]);
    __block dispatch_source_t terminate;
    signal(SIGTERM, SIG_IGN);
    signal(SIGINT, SIG_IGN);
    terminate = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0,
        dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
    dispatch_source_set_event_handler(terminate, ^{
      KCUAStopServer();
      dispatch_async(dispatch_get_main_queue(), ^{
        [NSApp terminate:nil];
      });
    });
    dispatch_resume(terminate);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      @try {
        KCUAStartServer(
            socket, runtime,
            [args containsObject:@"--allow-unsigned-launcher-local-dev"]);
      } @catch (NSException *error) {
        fprintf(stderr, "CUA startup failed: %s\n", error.reason.UTF8String);
        _exit(2);
      }
    });
    [app run];
  }
  return 0;
}
