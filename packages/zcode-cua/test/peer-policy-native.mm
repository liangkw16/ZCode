#import <Foundation/Foundation.h>
#include <stdlib.h>
extern bool KCUATrustedProductPeer(NSData *, NSData *, NSString *, NSString *,
                                   NSString *, bool);
int main() {
  @autoreleasepool {
    NSData *a = [@"cert-a" dataUsingEncoding:NSUTF8StringEncoding],
           *b = [@"cert-b" dataUsingEncoding:NSUTF8StringEncoding];
    NSString *root = @"/Applications/KCode.app";
    NSCAssert(
        KCUATrustedProductPeer(
            a, a, @"dev.zcode.app.kcode.helper",
            [root stringByAppendingString:
                      @"/Contents/Frameworks/KCode "
                      @"Helper.app/Contents/MacOS/KCode Helper"],
            root, true),
        @"Signed Host with Main lineage is allowed without TeamIdentifier");
    NSCAssert(!KCUATrustedProductPeer(
                  a, b, @"dev.zcode.app.kcode.helper",
                  [root stringByAppendingString:@"/Contents/MacOS/Host"], root,
                  true),
              @"Different leaf rejected");
    NSCAssert(!KCUATrustedProductPeer(
                  a, a, @"dev.zcode.app.kcode.helper",
                  [root stringByAppendingString:@"/Contents/MacOS/Host"], root,
                  false),
              @"Same certificate under another parent rejected");
    NSCAssert(!KCUATrustedProductPeer(a, a, @"node", @"/tmp/node", root, true),
              @"External Node rejected");
    NSCAssert(!KCUATrustedProductPeer(
                  a, a, @"dev.zcode.app.kcode.helper",
                  @"/Applications/KCode.app.evil/Contents/MacOS/Host", root,
                  true),
              @"Path prefix confusion rejected");
    NSCAssert(!KCUATrustedProductPeer(
                  nil, nil, @"dev.zcode.app.kcode",
                  [root stringByAppendingString:@"/Contents/MacOS/KCode"], root,
                  true),
              @"Missing signing identity rejected");
    char scratch[] = "/private/tmp/kcua-peer-path-XXXXXX";
    NSCAssert(mkdtemp(scratch) != nullptr, @"Private path fixture can be created");
    NSString *directory = [NSString stringWithUTF8String:scratch];
    NSFileManager *files = NSFileManager.defaultManager;
    NSString *app = [directory stringByAppendingPathComponent:@"KCode.app"];
    NSString *inside = [app stringByAppendingPathComponent:@"Contents/MacOS/Host"];
    NSCAssert([files createDirectoryAtPath:inside withIntermediateDirectories:YES attributes:nil error:nil],
              @"Fixture bundle exists");
    NSString *aliasRoot = [@"/tmp" stringByAppendingPathComponent:directory.lastPathComponent];
    NSString *aliasApp = [aliasRoot stringByAppendingPathComponent:@"KCode.app"];
    NSCAssert(KCUATrustedProductPeer(a, a, @"dev.zcode.app.kcode.helper", inside, aliasApp, true),
              @"Kernel and AppKit aliases resolve to the same bundle");
    NSString *outside = [directory stringByAppendingPathComponent:@"Outside"];
    NSCAssert([files createDirectoryAtPath:outside withIntermediateDirectories:YES attributes:nil error:nil],
              @"Outside fixture exists");
    NSString *escape = [app stringByAppendingPathComponent:@"Contents/Escape"];
    NSCAssert([files createSymbolicLinkAtPath:escape withDestinationPath:outside error:nil],
              @"Bundle escape fixture exists");
    NSCAssert(!KCUATrustedProductPeer(a, a, @"dev.zcode.app.kcode.helper", escape, app, true),
              @"Resolving an alias cannot admit a path outside the bundle");
    [files removeItemAtPath:directory error:nil];
    puts("verified peer policy regressions passed");
  }
}
