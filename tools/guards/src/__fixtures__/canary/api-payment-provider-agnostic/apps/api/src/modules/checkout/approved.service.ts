// provider-agnostic: the order flow reads the action type, never a provider id.
export function needsAction(type: string): boolean {
  return type !== 'none';
}
