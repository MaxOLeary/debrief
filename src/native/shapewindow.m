#include <node_api.h>
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

// Shapes an Electron panel to a 32px pill. CSS clip/mask only clip the page;
// the NSWindow is still a rectangle and macOS draws a 1px square border (and
// a square shadow) around it. Same fix as UltraWhisper: a stretchable
// rounded-rect mask on the content view, plus the window's cornerRadius.

static NSImage *roundedMask (CGFloat radius) {
  NSImage *img = [NSImage imageWithSize:NSMakeSize(radius * 2, radius * 2)
                                flipped:NO
                         drawingHandler:^BOOL (NSRect rect) {
    [[NSColor blackColor] set];
    [[NSBezierPath bezierPathWithRoundedRect:rect xRadius:radius yRadius:radius] fill];
    return YES;
  }];
  img.capInsets = NSEdgeInsetsMake(radius, radius, radius, radius);
  img.resizingMode = NSImageResizingModeStretch;
  return img;
}

static void maskView (NSView *view, NSImage *mask, CGFloat radius) {
  if ([view isKindOfClass:[NSVisualEffectView class]]) {
    [(NSVisualEffectView *)view setMaskImage:mask];
  }
  view.wantsLayer = YES;
  view.layer.cornerRadius = radius;
  view.layer.masksToBounds = YES;
}

static void maskTree (NSView *view, NSImage *mask, CGFloat radius) {
  maskView(view, mask, radius);
  for (NSView *sub in view.subviews) maskTree(sub, mask, radius);
}

static void runOnMain (void (^block)(void)) {
  if ([NSThread isMainThread]) block();
  else dispatch_sync(dispatch_get_main_queue(), block);
}

static napi_value Shape (napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

  napi_value no, yes;
  napi_get_boolean(env, false, &no);
  napi_get_boolean(env, true, &yes);
  if (argc < 2) return no;

  void *data = NULL;
  size_t len = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &len) != napi_ok ||
      !data || len < sizeof(void *)) {
    return no;
  }
  double radius = 32;
  napi_get_value_double(env, argv[1], &radius);
  if (radius < 1) return no;

  NSView *view = *(NSView * const *)data;
  if (!view) return no;

  __block BOOL ok = NO;
  runOnMain(^{
    NSWindow *win = view.window;
    if (!win) return;
    NSImage *mask = roundedMask((CGFloat)radius);
    NSView *cv = win.contentView ?: view;
    maskTree(cv, mask, (CGFloat)radius);
    // Theme frame is what actually draws the 1px square window chrome.
    if (cv.superview) maskView(cv.superview, mask, (CGFloat)radius);

    @try { [win setValue:@(radius) forKey:@"cornerRadius"]; } @catch (id e) {}
    @try { [win setValue:@(radius) forKey:@"_cornerRadius"]; } @catch (id e) {}

    [win setOpaque:NO];
    [win setBackgroundColor:NSColor.clearColor];
    [win invalidateShadow];
    ok = YES;
  });
  return ok ? yes : no;
}

static napi_value Init (napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "shape", NAPI_AUTO_LENGTH, Shape, NULL, &fn);
  napi_set_named_property(env, exports, "shape", fn);
  return exports;
}

NAPI_MODULE(shapewindow, Init)
