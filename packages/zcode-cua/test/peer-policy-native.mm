#import <Foundation/Foundation.h>
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
    puts("verified peer policy regressions passed");
  }
}
