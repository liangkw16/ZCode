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
