declare module 'prismarine-viewer' {
  import type { Bot } from 'mineflayer';
  interface ViewerOptions {
    viewDistance?: number;
    firstPerson?: boolean;
    port?: number;
    prefix?: string;
  }
  const pkg: {
    mineflayer: (bot: Bot, options?: ViewerOptions) => void;
    supportedVersions: string[];
  };
  export = pkg;
}
