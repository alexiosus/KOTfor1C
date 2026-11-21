import * as interaction from '../../src/kotInteraction';

/** VM fixtures sometimes omit window when the tested module never uses the UI. */
export const nativeInteraction = { ...interaction, kotWindow: <T extends object>(window: T): T => window ? interaction.kotWindow(window) : window };
