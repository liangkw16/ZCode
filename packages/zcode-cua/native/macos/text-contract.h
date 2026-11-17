#pragma once
#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>
struct KCUAKeyChord {
  CGKeyCode key;
  CGEventFlags flags;
};
NSString *KCUAScalarString(NSString *input, NSUInteger limit);
CFRange KCUATextSelection(NSString *value, NSArray *range);
KCUAKeyChord KCUAParseKeyChord(NSString *text);

id KCUAAXScalarValue(id value);
NSString *KCUAElementLabel(NSString *title, NSString *description);
