#import "../native/macos/protocol.h"
#import "../native/macos/text-contract.h"
#include <cassert>
static bool rejected(NSString *value, NSArray *range) {
  @try {
    KCUATextSelection(value, range);
    return false;
  } @catch (NSException *error) {
    return [error.name isEqual:@"not_selectable"] ||
           [error.name isEqual:@"invalid_request"];
  }
}
int main(void) {
  @autoreleasepool {
    unichar characters[] = {0x4e2d, 0xd83c, 'A', 0xdc00, 0xd83c, 0xdf1f};
    NSString *broken = [NSString stringWithCharacters:characters length:6];
    assert([KCUAScalarString(broken, 100) isEqual:@"中\uFFFDA\uFFFD🌟"]);
    assert([KCUAAXScalarValue(@YES) isEqual:@YES]);
    assert([KCUAAXScalarValue(@0.75) isEqual:@0.75]);
    assert([KCUAElementLabel(@"", @"Fixture text") isEqual:@"Fixture text"]);
    assert([KCUAElementLabel(@"Title", @"Description") isEqual:@"Title"]);
    CFRange legal = KCUATextSelection(@"A🌟B", @[ @1, @2 ]);
    assert(legal.location == 1 && legal.length == 2);
    assert(rejected(@"A🌟B", @[ @2, @1 ]));
    assert(rejected(@"A🌟B", @[ @1, @1 ]));
    assert(rejected(@"ABCD", @[ @1.5, @1 ]));
    assert(rejected(@"ABCD", @[ @YES, @1 ]));
    assert(rejected(@"A🌟B", @[ @0, @(-1) ]));
    assert(rejected(@"A🌟B", @[ @0, @9 ]));
    CFRange end = KCUATextSelection(@"A🌟B", @[ @4, @0 ]);
    assert(end.location == 4 && end.length == 0);
    // 省略范围即全选：长度取元素当前值，不受 Host 侧观测截断（16,384 码元）影响。
    CFRange whole = KCUATextSelection(@"A🌟B", nil);
    assert(whole.location == 0 && whole.length == 4);
    NSString *long_ = [@"" stringByPaddingToLength:20000 withString:@"x" startingAtIndex:0];
    assert(KCUATextSelection(long_, nil).length == 20000);
    assert(KCUATextSelection(@"", nil).length == 0);
    bool notText = false;
    id numeric = @42;
    @try {
      KCUATextSelection(numeric, nil);
    } @catch (NSException *error) {
      notText = [error.name isEqual:@"not_selectable"];
    }
    assert(notText);
    KCUAKeyChord chord = KCUAParseKeyChord(@"cmd+shift+k");
    assert(chord.key == 40);
    assert(chord.flags == (kCGEventFlagMaskCommand | kCGEventFlagMaskShift));
    bool invalid = false;
    @try {
      KCUAParseKeyChord(@"foo+a");
    } @catch (NSException *error) {
      invalid = [error.name isEqual:@"invalid_request"];
    }
    assert(invalid);
    puts("native Unicode, selection boundaries and key chords passed");
  }
}
