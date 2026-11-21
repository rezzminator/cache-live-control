export type ControlAction = 'on' | 'off' | 'status' | 'invalid';
export function parseControl(args: string): ControlAction { const word = args.trim(); return word === '' || word === 'status' ? 'status' : word === 'on' || word === 'off' ? word : 'invalid'; }
export function effectiveEnabled(launch: boolean, override: boolean | null): boolean { return override ?? launch; }
