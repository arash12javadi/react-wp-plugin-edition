/**
 * The Motion effects of the Advanced tab: which effect an element plays, how it is timed and how
 * often it repeats. Shared by the controls (lib/controls.ts) and the renderer (render/NodeView.tsx
 * and the keyframes in render/builder.css), so the three never disagree about a value.
 *
 * Two kinds of effect share the one select:
 *  - entrance animations reveal the element once, when it first scrolls into view, and start from
 *    invisible;
 *  - attention animations (pulse, heartbeat, shake, swing, wobble, float, bounce, tada, spin) leave
 *    the element visible and move it in place, so "Default" repeats them without end.
 *
 * The values written by older versions (fadeIn, slideUp, slideDown, slideLeft, slideRight,
 * zoomIn) keep their names and their meaning, so a saved page plays exactly as it did.
 */
import type { AdvancedSettings, AnimationEasing, AnimationRepeat, EntranceAnimation } from './types';

export const animationOptions: Array<[EntranceAnimation, string]> = [
  ['', 'None'],
  ['fadeIn', 'Fade in'],
  ['slideUp', 'Slide up'],
  ['slideDown', 'Slide down'],
  ['slideLeft', 'Slide in from right'],
  ['slideRight', 'Slide in from left'],
  ['zoomIn', 'Zoom in'],
  ['zoomOut', 'Zoom out'],
  ['rotateIn', 'Rotate in'],
  ['flipInX', 'Flip up (3D)'],
  ['flipInY', 'Flip sideways (3D)'],
  ['bounceIn', 'Bounce in'],
  ['blurIn', 'Blur in'],
  ['pulse', 'Pulse (loops)'],
  ['heartbeat', 'Heartbeat (loops)'],
  ['shake', 'Shake (loops)'],
  ['swing', 'Swing (loops)'],
  ['wobble', 'Wobble (loops)'],
  ['float', 'Float (loops)'],
  ['bounce', 'Bounce (loops)'],
  ['tada', 'Celebrate (loops)'],
  ['spin', 'Spin (loops)'],
];

/** Effects that keep moving in place. */
const loopAnimations = new Set<string>(['pulse', 'heartbeat', 'shake', 'swing', 'wobble', 'float', 'bounce', 'tada', 'spin']);

export const isLoopAnimation = (animation: string): boolean => loopAnimations.has(animation);

const knownAnimations = new Set<string>(animationOptions.map(([value]) => value).filter(Boolean));

/**
 * Whether this version can play a stored effect. An unknown value (an older or newer page, or a
 * renamed effect) is ignored instead of leaving the element invisible on the public site.
 */
export const isKnownAnimation = (animation: string): boolean => knownAnimations.has(animation);

export const easingOptions: Array<[AnimationEasing, string]> = [
  ['', 'Smooth (default)'],
  ['ease', 'Ease'],
  ['linear', 'Linear'],
  ['easeIn', 'Ease in'],
  ['easeOut', 'Ease out'],
  ['easeInOut', 'Ease in and out'],
  ['backOut', 'Overshoot'],
  ['spring', 'Spring'],
];

const easingValues: Record<AnimationEasing, string> = {
  '': 'cubic-bezier(.2, .7, .2, 1)',
  ease: 'ease',
  linear: 'linear',
  easeIn: 'ease-in',
  easeOut: 'ease-out',
  easeInOut: 'ease-in-out',
  backOut: 'cubic-bezier(.34, 1.56, .64, 1)',
  spring: 'cubic-bezier(.22, 1, .36, 1)',
};

/** The CSS timing function for a stored easing value. Unknown values fall back to the default. */
export const easingValue = (easing?: AnimationEasing): string => easingValues[easing || ''] || easingValues[''];

export const repeatOptions: Array<[AnimationRepeat, string]> = [
  ['', 'Default'],
  ['1', 'Once'],
  ['2', '2 times'],
  ['3', '3 times'],
  ['5', '5 times'],
  ['10', '10 times'],
  ['infinite', 'Unlimited (repeat forever)'],
];

const repeatValues = new Set<string>(repeatOptions.map(([value]) => value).filter(Boolean));

/** The CSS iteration count: unlimited for a loop effect left on Default, otherwise once. */
export const iterationValue = (animation: string, repeat?: AnimationRepeat): string => {
  if (repeat && repeatValues.has(repeat)) return repeat;
  return isLoopAnimation(animation) ? 'infinite' : '1';
};

/**
 * Everything that decides how an element moves, as one comparable string. The editor replays the
 * effect when this changes (see editor/Canvas.tsx), so changing the effect or any of its timing
 * controls shows the result. Empty for an element with no known effect.
 */
export function motionSignature(advanced: AdvancedSettings | undefined): string {
  const animation = advanced?.animation;
  if (!animation || !isKnownAnimation(animation)) return '';
  return [
    animation,
    advanced.animationDuration ?? '',
    advanced.animationDelay ?? '',
    advanced.animationEasing ?? '',
    advanced.animationRepeat ?? '',
  ].join('|');
}
