export interface EvolutionConstraints {
  maxInstructionsLength?: number;
  requiredSections?: string[];
  validate?: (instructions: string) => { passed: boolean; reason?: string };
}

export interface ConstraintResult { passed: boolean; reasons: string[]; }

export function validateConstraints(instructions: string, constraints: EvolutionConstraints = {}): ConstraintResult {
  const reasons: string[] = [];
  if (!instructions.trim()) reasons.push('Instructions must not be empty');
  if (constraints.maxInstructionsLength && instructions.length > constraints.maxInstructionsLength) reasons.push(`Instructions exceed ${constraints.maxInstructionsLength} characters`);
  for (const section of constraints.requiredSections ?? []) if (!instructions.toLowerCase().includes(section.toLowerCase())) reasons.push(`Missing required section: ${section}`);
  const custom = constraints.validate?.(instructions);
  if (custom && !custom.passed && custom.reason) reasons.push(custom.reason);
  return { passed: reasons.length === 0, reasons };
}
