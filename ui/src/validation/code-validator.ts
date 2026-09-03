/**
 * Code Validator - Validate syntax, logic, and best practices
 * Checks for correctness and code quality issues
 */

import { parseJson } from '../utils/json.js';

export interface ValidationIssue {
  severity: 'critical' | 'warning' | 'info';
  category: 'syntax' | 'logic' | 'style' | 'performance' | 'security';
  description: string;
  line?: number;
  suggestion?: string;
}

export interface CodeValidationResult {
  isValid: boolean;
  issues: ValidationIssue[];
  criticalCount: number;
  warningCount: number;
  score: number; // 0-100
}

export class CodeValidator {
  /**
   * Validate code syntax
   */
  async validateSyntax(code: string, language: string = 'typescript'): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    try {
      switch (language.toLowerCase()) {
        case 'typescript':
        case 'ts':
        case 'javascript':
        case 'js':
          issues.push(...this.validateTypeScript(code));
          break;
        case 'python':
        case 'py':
          issues.push(...this.validatePython(code));
          break;
        case 'json':
          issues.push(...this.validateJSON(code));
          break;
        default:
          issues.push(...this.validateGeneric(code));
      }
    } catch (error) {
      issues.push({
        severity: 'critical',
        category: 'syntax',
        description: `Syntax validation failed: ${String(error)}`,
        suggestion: 'Check code for basic syntax errors',
      });
    }

    return issues;
  }

  /**
   * Validate logic and structure
   */
  async validateLogic(code: string, language: string = 'typescript'): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    // Check for common logic errors
    const logicIssues = this.checkCommonLogicErrors(code);
    issues.push(...logicIssues);

    // Check for incomplete implementations
    const incompleteIssues = this.checkIncompleteImplementations(code);
    issues.push(...incompleteIssues);

    // Check for error handling
    const errorHandlingIssues = this.checkErrorHandling(code);
    issues.push(...errorHandlingIssues);

    return issues;
  }

  /**
   * Validate best practices and code quality
   */
  async validateBestPractices(
    code: string,
    language: string = 'typescript'
  ): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];

    // Check naming conventions
    const namingIssues = this.checkNamingConventions(code, language);
    issues.push(...namingIssues);

    // Check code organization
    const organizationIssues = this.checkCodeOrganization(code);
    issues.push(...organizationIssues);

    // Check for code smells
    const smellIssues = this.checkCodeSmells(code);
    issues.push(...smellIssues);

    // Check documentation
    const docIssues = this.checkDocumentation(code);
    issues.push(...docIssues);

    return issues;
  }

  /**
   * Run comprehensive validation
   */
  async validateComprehensive(
    code: string,
    language: string = 'typescript'
  ): Promise<CodeValidationResult> {
    const syntaxIssues = await this.validateSyntax(code, language);
    const logicIssues = await this.validateLogic(code, language);
    const practiceIssues = await this.validateBestPractices(code, language);

    const allIssues = [...syntaxIssues, ...logicIssues, ...practiceIssues];
    const criticalCount = allIssues.filter((i) => i.severity === 'critical').length;
    const warningCount = allIssues.filter((i) => i.severity === 'warning').length;

    // Calculate score: 100 points minus penalties
    let score = 100;
    score -= criticalCount * 25; // Each critical issue: -25 points
    score -= warningCount * 5; // Each warning: -5 points
    score = Math.max(0, score);

    return {
      isValid: criticalCount === 0,
      issues: allIssues,
      criticalCount,
      warningCount,
      score: Math.round(score),
    };
  }

  // --- Private Validation Methods ---

  private validateTypeScript(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for unmatched braces
    const braceCount = (code.match(/{/g) || []).length - (code.match(/}/g) || []).length;
    if (braceCount !== 0) {
      issues.push({
        severity: 'critical',
        category: 'syntax',
        description: 'Unmatched braces detected',
        suggestion: `Add ${Math.abs(braceCount)} closing brace(s)`,
      });
    }

    // Check for unmatched parentheses
    const parenCount = (code.match(/\(/g) || []).length - (code.match(/\)/g) || []).length;
    if (parenCount !== 0) {
      issues.push({
        severity: 'critical',
        category: 'syntax',
        description: 'Unmatched parentheses detected',
        suggestion: `Add ${Math.abs(parenCount)} closing parenthesis/parentheses`,
      });
    }

    // Check for unmatched brackets
    const bracketCount = (code.match(/\[/g) || []).length - (code.match(/\]/g) || []).length;
    if (bracketCount !== 0) {
      issues.push({
        severity: 'critical',
        category: 'syntax',
        description: 'Unmatched brackets detected',
        suggestion: `Add ${Math.abs(bracketCount)} closing bracket(s)`,
      });
    }

    // Check for common TypeScript errors
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check for missing semicolons (optional but good practice)
      if (line.match(/[^{};]\s*$/) && !line.trim().startsWith('//')) {
        issues.push({
          severity: 'info',
          category: 'style',
          description: 'Missing semicolon',
          line: i + 1,
          suggestion: 'Add semicolon at end of statement',
        });
      }

      // Check for console.log statements
      if (line.includes('console.log')) {
        issues.push({
          severity: 'warning',
          category: 'style',
          description: 'Debug console.log found in code',
          line: i + 1,
          suggestion: 'Remove console.log or use proper logging',
        });
      }
    }

    return issues;
  }

  private validatePython(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    const lines = code.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      if (!trimmedLine || trimmedLine.startsWith('#')) continue;

      // Check indentation
      const currentIndent = line.length - line.trimLeft().length;
      if (currentIndent % 4 !== 0) {
        issues.push({
          severity: 'warning',
          category: 'style',
          description: 'Non-standard indentation (should be multiple of 4)',
          line: i + 1,
          suggestion: 'Use 4 spaces for indentation',
        });
      }

      // Check for missing colons
      if (
        (trimmedLine.startsWith('if ') ||
          trimmedLine.startsWith('for ') ||
          trimmedLine.startsWith('while ') ||
          trimmedLine.startsWith('def ')) &&
        !trimmedLine.endsWith(':')
      ) {
        issues.push({
          severity: 'critical',
          category: 'syntax',
          description: 'Missing colon after control statement',
          line: i + 1,
          suggestion: 'Add colon (:) at end of line',
        });
      }
    }

    return issues;
  }

  private validateJSON(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    const parsed = parseJson(code);
    if (parsed === undefined) {
      issues.push({
        severity: 'critical',
        category: 'syntax',
        description: 'Invalid JSON: parse error',
        suggestion: 'Fix JSON syntax errors',
      });
    }

    return issues;
  }

  private validateGeneric(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Basic brace matching
    const openBraces = (code.match(/{/g) || []).length;
    const closeBraces = (code.match(/}/g) || []).length;

    if (openBraces !== closeBraces) {
      issues.push({
        severity: 'warning',
        category: 'syntax',
        description: 'Unmatched braces detected',
        suggestion: 'Check brace matching',
      });
    }

    return issues;
  }

  private checkCommonLogicErrors(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for assignments in conditionals
    if (code.match(/if\s*\([^)]*=(?!=)[^)]*\)/)) {
      issues.push({
        severity: 'warning',
        category: 'logic',
        description: 'Assignment in conditional (did you mean ==?)',
        suggestion: 'Use == or === for comparison, not assignment',
      });
    }

    // Check for infinite loops
    if (code.match(/while\s*\(\s*true\s*\)/)) {
      issues.push({
        severity: 'warning',
        category: 'logic',
        description: 'Infinite loop detected',
        suggestion: 'Ensure loop has proper exit condition',
      });
    }

    // Check for unreachable code
    if (code.match(/return\s*;[\s\S]*[^\s]/)) {
      issues.push({
        severity: 'warning',
        category: 'logic',
        description: 'Unreachable code detected after return',
        suggestion: 'Remove code after return statement',
      });
    }

    return issues;
  }

  private checkIncompleteImplementations(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for TODO comments
    const todoMatches = code.match(/\/\/\s*TODO\b|\/\*.*TODO.*\*\//gi);
    if (todoMatches && todoMatches.length > 0) {
      issues.push({
        severity: 'info',
        category: 'logic',
        description: `Found ${todoMatches.length} TODO comment(s)`,
        suggestion: 'Complete TODO items before submission',
      });
    }

    // Check for placeholder values
    if (code.includes('...') || code.includes('FIXME')) {
      issues.push({
        severity: 'warning',
        category: 'logic',
        description: 'Incomplete or placeholder code detected',
        suggestion: 'Complete all placeholder implementations',
      });
    }

    return issues;
  }

  private checkErrorHandling(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for try-catch usage
    const tryBlocks = code.match(/try\s*{/g) || [];
    const catchBlocks = code.match(/catch\s*[({]/g) || [];

    if (tryBlocks.length > 0 && tryBlocks.length !== catchBlocks.length) {
      issues.push({
        severity: 'warning',
        category: 'logic',
        description: 'Try block without catch handler',
        suggestion: 'Add catch block for error handling',
      });
    }

    // Check for empty catch blocks
    if (code.match(/catch\s*[({][^}]*{[^}]*}/)) {
      issues.push({
        severity: 'warning',
        category: 'logic',
        description: 'Empty catch block (swallowing errors)',
        suggestion: 'Add error handling or at least log the error',
      });
    }

    return issues;
  }

  private checkNamingConventions(code: string, language: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for single letter variables (except i, j, k in loops)
    const varMatches = code.match(/(?:let|const|var|function)\s+([a-zA-Z_]\w*)/g) || [];
    for (const match of varMatches) {
      const name = match.split(/\s+/)[1];
      if (name && name.length === 1 && !['i', 'j', 'k', 'x', 'y', 'z'].includes(name)) {
        issues.push({
          severity: 'info',
          category: 'style',
          description: `Single letter variable name: ${name}`,
          suggestion: 'Use descriptive variable names',
        });
      }
    }

    return issues;
  }

  private checkCodeOrganization(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for very long functions
    const functionMatches =
      code.match(
        /(?:function|async|=>)[^{]*{[\s\S]*?}(?=\s*(?:function|async|const|let|var|class|export|$))/g
      ) || [];
    for (const func of functionMatches) {
      const lines = func.split('\n').length;
      if (lines > 50) {
        issues.push({
          severity: 'info',
          category: 'style',
          description: `Long function detected (${lines} lines)`,
          suggestion: 'Consider breaking into smaller functions',
        });
      }
    }

    return issues;
  }

  private checkCodeSmells(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for magic numbers
    if (code.match(/[=:]\s*\d{3,}/)) {
      issues.push({
        severity: 'info',
        category: 'style',
        description: 'Magic number detected',
        suggestion: 'Extract magic numbers to named constants',
      });
    }

    // Check for repeated code (simple heuristic)
    const lines = code.split('\n').filter((l) => l.trim());
    const lineMap = new Map<string, number>();
    for (const line of lines) {
      lineMap.set(line, (lineMap.get(line) || 0) + 1);
    }

    for (const [line, count] of lineMap) {
      if (count >= 3 && line.length > 20) {
        issues.push({
          severity: 'info',
          category: 'style',
          description: 'Code duplication detected',
          suggestion: 'Extract repeated code to a function',
        });
        break; // Only report once
      }
    }

    return issues;
  }

  private checkDocumentation(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for functions without documentation
    const functionMatches =
      code.match(/(?:async\s+)?function\s+\w+|(?:const|let)\s+\w+\s*=\s*(?:async\s*)?[(]/g) || [];
    const commentMatches = code.match(/\/\/|\/\*|\/\*\*/g) || [];

    const docRatio = commentMatches.length / Math.max(1, functionMatches.length);
    if (docRatio < 0.3 && functionMatches.length > 0) {
      issues.push({
        severity: 'info',
        category: 'style',
        description: 'Low documentation coverage',
        suggestion: 'Add JSDoc or comments to functions',
      });
    }

    return issues;
  }
}

export default CodeValidator;
