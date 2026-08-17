import type { Bot } from 'mineflayer';
import { perceptionTools } from './perception.js';
import { movementTools } from './movement.js';
import { worldTools } from './world.js';
import { inventoryTools } from './inventory.js';
import { combatTools, interactionTools, chatTools } from './actions.js';
import { visionTools } from './vision.js';
import { memoryTools } from './memory.js';

/** Every mineflayer capability, exposed as Strands tools bound to one bot. */
export function allTools(bot: Bot) {
  return [
    ...perceptionTools(bot),
    ...movementTools(bot),
    ...worldTools(bot),
    ...inventoryTools(bot),
    ...combatTools(bot),
    ...interactionTools(bot),
    ...chatTools(bot),
    ...visionTools(bot),
    ...memoryTools(bot),
  ];
}

export { perceptionTools, movementTools, worldTools, inventoryTools, combatTools, interactionTools, chatTools, visionTools, memoryTools };
export { closeViewer } from './vision.js';
