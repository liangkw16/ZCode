#import "text-contract.h"
#import "protocol.h"
#include <cmath>
NSString *KCUAScalarString(NSString *input, NSUInteger limit) {
  if (![input isKindOfClass:NSString.class])
    return nil;
  NSUInteger length = MIN(input.length, limit);
  NSMutableString *result = [NSMutableString stringWithCapacity:length];
  for (NSUInteger i = 0; i < length; i++) {
    unichar ch = [input characterAtIndex:i];
    if (CFStringIsSurrogateHighCharacter(ch)) {
      if (i + 1 < length &&
          CFStringIsSurrogateLowCharacter([input characterAtIndex:i + 1])) {
        unichar pair[2] = {ch, [input characterAtIndex:++i]};
        [result appendString:[NSString stringWithCharacters:pair length:2]];
      } else
        [result appendString:@"\uFFFD"];
    } else if (CFStringIsSurrogateLowCharacter(ch))
      [result appendString:@"\uFFFD"];
    else
      [result appendString:[NSString stringWithCharacters:&ch length:1]];
  }
  return result;
}

KCUAKeyChord KCUAParseKeyChord(NSString *text) {
  if (![text isKindOfClass:NSString.class] || !text.length)
    KCUAFail(@"invalid_request", @"Key chord must be a nonempty string");
  static NSDictionary<NSString *, NSNumber *> *codes;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    codes = @{
      @"a" : @0,
      @"s" : @1,
      @"d" : @2,
      @"f" : @3,
      @"h" : @4,
      @"g" : @5,
      @"z" : @6,
      @"x" : @7,
      @"c" : @8,
      @"v" : @9,
      @"b" : @11,
      @"q" : @12,
      @"w" : @13,
      @"e" : @14,
      @"r" : @15,
      @"y" : @16,
      @"t" : @17,
      @"1" : @18,
      @"2" : @19,
      @"3" : @20,
      @"4" : @21,
      @"6" : @22,
      @"5" : @23,
      @"=" : @24,
      @"9" : @25,
      @"7" : @26,
      @"-" : @27,
      @"8" : @28,
      @"0" : @29,
      @"]" : @30,
      @"o" : @31,
      @"u" : @32,
      @"[" : @33,
      @"i" : @34,
      @"p" : @35,
      @"return" : @36,
      @"enter" : @36,
      @"l" : @37,
      @"j" : @38,
      @"'" : @39,
      @"k" : @40,
      @";" : @41,
      @"\\" : @42,
      @"," : @43,
      @"/" : @44,
      @"n" : @45,
      @"m" : @46,
      @"." : @47,
      @"tab" : @48,
      @"space" : @49,
      @"`" : @50,
      @"backspace" : @51,
      @"esc" : @53,
      @"escape" : @53,
      @"cmd" : @55,
      @"shift" : @56,
      @"alt" : @58,
      @"ctrl" : @59,
      @"home" : @115,
      @"pageup" : @116,
      @"delete" : @117,
      @"end" : @119,
      @"pagedown" : @121,
      @"left" : @123,
      @"right" : @124,
      @"down" : @125,
      @"up" : @126,
      @"f1" : @122,
      @"f2" : @120,
      @"f3" : @99,
      @"f4" : @118,
      @"f5" : @96,
      @"f6" : @97,
      @"f7" : @98,
      @"f8" : @100,
      @"f9" : @101,
      @"f10" : @109,
      @"f11" : @103,
      @"f12" : @111
    };
  });
  NSArray<NSString *> *tokens =
      [text.lowercaseString componentsSeparatedByString:@"+"];
  CGEventFlags flags = 0;
  NSString *key;
  for (NSString *raw in tokens) {
    NSString *token = [raw
        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    if ([token isEqual:@"cmd"] || [token isEqual:@"command"])
      flags |= kCGEventFlagMaskCommand;
    else if ([token isEqual:@"ctrl"] || [token isEqual:@"control"])
      flags |= kCGEventFlagMaskControl;
    else if ([token isEqual:@"alt"] || [token isEqual:@"option"])
      flags |= kCGEventFlagMaskAlternate;
    else if ([token isEqual:@"shift"])
      flags |= kCGEventFlagMaskShift;
    else {
      if (key)
        KCUAFail(@"invalid_request",
                 @"A chord may contain only one nonmodifier key");
      key = token;
    }
  }
  if (!key && tokens.count == 1)
    key = tokens.firstObject;
  NSNumber *code = codes[key];
  if (!code)
    KCUAFail(@"invalid_request", @"Unsupported key chord");
  return {(CGKeyCode)code.unsignedIntValue, flags};
}

CFRange KCUATextSelection(NSString *value, NSArray *range) {
  if (![range isKindOfClass:NSArray.class] || range.count != 2 ||
      ![range[0] isKindOfClass:NSNumber.class] ||
      ![range[1] isKindOfClass:NSNumber.class])
    KCUAFail(@"invalid_request", @"text_range requires start and length");
  for (NSNumber *part in range) {
    double number = part.doubleValue;
    if (CFGetTypeID((__bridge CFTypeRef)part) == CFBooleanGetTypeID() ||
        !std::isfinite(number) || number < 0 || number > 9007199254740991.0 ||
        floor(number) != number)
      KCUAFail(@"invalid_request",
               @"Text range boundaries must be nonnegative safe integers");
  }
  NSInteger start = [range[0] integerValue], length = [range[1] integerValue];
  if (![value isKindOfClass:NSString.class] || start < 0 || length < 0 ||
      start > (NSInteger)value.length ||
      length > (NSInteger)value.length - start ||
      (start > 0 && start < (NSInteger)value.length &&
       CFStringIsSurrogateLowCharacter([value characterAtIndex:start]) &&
       CFStringIsSurrogateHighCharacter([value characterAtIndex:start - 1])) ||
      (start + length > 0 && start + length < (NSInteger)value.length &&
       CFStringIsSurrogateLowCharacter([value
           characterAtIndex:start + length]) &&
       CFStringIsSurrogateHighCharacter([value
           characterAtIndex:start + length - 1])))
    KCUAFail(@"not_selectable",
             @"Text selection splits a character or exceeds the current value");
  return CFRangeMake(start, length);
}

id KCUAAXScalarValue(id value) {
  if ([value isKindOfClass:NSString.class])
    return KCUAScalarString(value, 16384);
  if ([value isKindOfClass:NSNumber.class] &&
      std::isfinite([value doubleValue]))
    return value;
  return [NSNull null];
}
NSString *KCUAElementLabel(NSString *title, NSString *description) {
  return title.length ? title : description;
}
