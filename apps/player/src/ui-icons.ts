// Small interface marks share the player icon family's rounded, currentColor strokes.
import headphones from '../../../assets/icons/headphones.svg?raw';
import tap from '../../../assets/icons/tap-ripple.svg?raw';
import drag from '../../../assets/icons/drag-ripple.svg?raw';
import pen from '../../../assets/icons/story-pen.svg?raw';
import spark from '../../../assets/icons/story-spark.svg?raw';
import choice from '../../../assets/icons/story-choice.svg?raw';
import play from '../../../assets/icons/play.svg?raw';
import stop from '../../../assets/icons/stop.svg?raw';
import { ICON_SOUND_ON } from './icons';

const marks = { headphones, tap, drag, pen, spark, choice, play, stop, sound: ICON_SOUND_ON };
export function uiIcon(name: keyof typeof marks): string {
    return `<span class="ui-icon" aria-hidden="true">${marks[name]}</span>`;
}
