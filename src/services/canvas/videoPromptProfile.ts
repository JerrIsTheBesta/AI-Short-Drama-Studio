/** The legacy videoModel field also routes custom profiles and is not their model identity. */
export function isH3PromptProfile(
  profile: { workflowId?: string; name?: string } | undefined,
  legacyModel?: string
): boolean {
  // These are explicit built-in choices, not the generic profile routing marker.
  if (legacyModel === 'wan-prime') return false
  if (legacyModel === 'h3-v5') return true
  if (profile) {
    const model = `${profile.workflowId || ''} ${profile.name || ''}`
    return /(?:^|[^a-z0-9])h3(?:[^a-z0-9]|$)/i.test(model)
  }
  return legacyModel === 'h3' || legacyModel === 'h3-v5'
}
