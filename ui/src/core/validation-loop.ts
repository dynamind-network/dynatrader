/**
 * Validation Loop - Implements Dexter-style iteration control
 * Executes with validation, iterates up to 3 times to improve quality
 */

import { ValidationAgent, type ValidationSummary } from '../agents/validation-agent.js';

export interface ExecutionResult {
  content: string;
  type?: 'code' | 'text' | 'analysis';
  metadata?: Record<string, unknown>;
}

export interface ValidatedExecutionResult {
  content: string;
  type?: 'code' | 'text' | 'analysis';
  validation: ValidationSummary;
  iterations: number;
  improved: boolean;
  converged: boolean;
  feedback?: string;
  metadata?: Record<string, unknown>;
}

export class ValidationLoop {
  private validationAgent: ValidationAgent;
  private maxIterations: number = 3;
  private confidenceThreshold: number = 0.8;
  private minImprovement: number = 0.05; // Minimum confidence improvement required

  constructor(options?: {
    maxIterations?: number;
    confidenceThreshold?: number;
    minImprovement?: number;
  }) {
    this.validationAgent = new ValidationAgent();
    if (options?.maxIterations) this.maxIterations = options.maxIterations;
    if (options?.confidenceThreshold) this.confidenceThreshold = options.confidenceThreshold;
    if (options?.minImprovement) this.minImprovement = options.minImprovement;
  }

  /**
   * Execute with validation loop
   * Runs executor and validates output, iterating up to maxIterations if needed
   */
  async executeWithValidation(
    userRequest: string,
    executor: (feedback?: string) => Promise<ExecutionResult>,
    options?: {
      initialFeedback?: string;
      outputType?: 'code' | 'text' | 'analysis';
      verbose?: boolean;
    }
  ): Promise<ValidatedExecutionResult> {
    const outputType = options?.outputType || 'text';
    const verbose = options?.verbose || false;

    let currentResult: ExecutionResult | null;
    let currentValidation: ValidationSummary | null;
    let bestResult: ExecutionResult | null = null;
    let bestValidation: ValidationSummary | null = null;
    let bestConfidence: number = 0;
    let feedback: string | undefined = options?.initialFeedback;
    let converged = false;

    if (verbose) {
      console.log(
        `[ValidationLoop] Starting validation loop (max ${this.maxIterations} iterations)`
      );
      console.log(
        `[ValidationLoop] Confidence threshold: ${(this.confidenceThreshold * 100).toFixed(1)}%`
      );
    }

    // Iteration loop
    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
      try {
        if (verbose) {
          console.log(`\n[ValidationLoop] Iteration ${iteration}/${this.maxIterations}`);
        }

        // Execute with current feedback
        currentResult = await executor(feedback);

        // Validate output
        currentValidation = await this.validationAgent.validate(
          userRequest,
          currentResult.content,
          currentResult.type || outputType
        );

        if (verbose) {
          console.log(
            `[ValidationLoop] Confidence: ${(currentValidation.confidence * 100).toFixed(1)}%`
          );
          console.log(`[ValidationLoop] Score: ${currentValidation.overallScore}/100`);
          if (currentValidation.criticalIssues.length > 0) {
            console.log(
              `[ValidationLoop] Critical issues: ${currentValidation.criticalIssues.length}`
            );
          }
        }

        // Track best result
        if (currentValidation.confidence > bestConfidence) {
          bestConfidence = currentValidation.confidence;
          bestResult = currentResult;
          bestValidation = currentValidation;

          if (verbose) {
            console.log(`[ValidationLoop] New best: ${(bestConfidence * 100).toFixed(1)}%`);
          }
        }

        // Check if passed validation
        if (currentValidation.passed) {
          if (verbose) {
            console.log(`[ValidationLoop] PASSED validation on iteration ${iteration}`);
          }
          converged = true;
          break;
        }

        // Check if confidence threshold reached
        if (currentValidation.confidence >= this.confidenceThreshold) {
          if (verbose) {
            console.log(`[ValidationLoop] Reached confidence threshold on iteration ${iteration}`);
          }
          converged = true;
          break;
        }

        // Prepare feedback for next iteration if there are iterations left
        if (iteration < this.maxIterations) {
          feedback = this.generateIterationFeedback(currentValidation);
          if (verbose) {
            console.log(`[ValidationLoop] Generated feedback for next iteration`);
          }
        }
      } catch (error) {
        if (verbose) {
          console.error(`[ValidationLoop] Error in iteration ${iteration}:`, error);
        }
        // Continue to next iteration or use best result so far
        if (!bestResult) {
          throw new Error(`Validation loop failed on iteration ${iteration}: ${String(error)}`, {
            cause: error,
          });
        }
      }
    }

    if (verbose) {
      console.log(`\n[ValidationLoop] Loop completed after ${this.maxIterations} iteration(s)`);
    }

    // Return best result found
    if (!bestResult || !bestValidation) {
      throw new Error('Validation loop produced no valid results');
    }

    return {
      content: bestResult.content,
      type: bestResult.type || outputType,
      validation: bestValidation,
      iterations: this.maxIterations,
      improved: bestConfidence > 0.5, // Consider improved if confidence > 50%
      converged,
      feedback: this.generateFinalFeedback(bestValidation),
      metadata: bestResult.metadata,
    };
  }

  /**
   * Generate structured feedback for iteration
   */
  private generateIterationFeedback(validation: ValidationSummary): string {
    const feedbackParts: string[] = [];

    feedbackParts.push('[Validation Feedback]');
    feedbackParts.push('');

    // Critical issues to fix
    if (validation.criticalIssues.length > 0) {
      feedbackParts.push('CRITICAL ISSUES TO FIX:');
      validation.criticalIssues.forEach((issue) => {
        feedbackParts.push(`- ${issue}`);
      });
      feedbackParts.push('');
    }

    // Missing requirements
    if (validation.requirements.uncovered.length > 0) {
      feedbackParts.push('MISSING REQUIREMENTS:');
      validation.requirements.uncovered.forEach((req) => {
        feedbackParts.push(`- ${req.text}`);
      });
      feedbackParts.push('');
    }

    // Quality improvements
    if (validation.quality.weaknesses.length > 0) {
      feedbackParts.push('QUALITY IMPROVEMENTS NEEDED:');
      validation.quality.weaknesses.slice(0, 3).forEach((weakness) => {
        feedbackParts.push(`- ${weakness}`);
      });
      feedbackParts.push('');
    }

    // Actionable recommendations
    if (validation.suggestions.length > 0) {
      feedbackParts.push('SPECIFIC RECOMMENDATIONS:');
      validation.suggestions.slice(0, 3).forEach((suggestion) => {
        feedbackParts.push(`- ${suggestion}`);
      });
    }

    return feedbackParts.join('\n');
  }

  /**
   * Generate final feedback message
   */
  private generateFinalFeedback(validation: ValidationSummary): string {
    const feedbackParts: string[] = [];

    if (validation.passed) {
      feedbackParts.push('Validation PASSED');
      feedbackParts.push(`Confidence: ${(validation.confidence * 100).toFixed(1)}%`);
      feedbackParts.push(`Score: ${validation.overallScore}/100`);
      feedbackParts.push(`Quality: ${validation.quality.level}`);
    } else {
      feedbackParts.push('Validation NEEDS IMPROVEMENT');
      feedbackParts.push(`Confidence: ${(validation.confidence * 100).toFixed(1)}%`);
      feedbackParts.push(`Score: ${validation.overallScore}/100`);
      feedbackParts.push('');
      feedbackParts.push('Issues to address:');
      [...validation.criticalIssues, ...validation.warnings].slice(0, 3).forEach((issue) => {
        feedbackParts.push(`- ${issue}`);
      });
    }

    return feedbackParts.join('\n');
  }

  /**
   * Quick validation without iteration
   * Used for validation-only operations
   */
  async validateOnly(
    userRequest: string,
    output: string,
    outputType: 'code' | 'text' | 'analysis' = 'text'
  ): Promise<ValidationSummary> {
    return this.validationAgent.validate(userRequest, output, outputType);
  }

  /**
   * Format validation result for display
   */
  formatResult(result: ValidatedExecutionResult): string {
    const lines: string[] = [];

    lines.push('=== EXECUTION RESULT WITH VALIDATION ===');
    lines.push('');

    // Execution summary
    lines.push('EXECUTION SUMMARY:');
    lines.push(`  Iterations: ${result.iterations}`);
    lines.push(`  Converged: ${result.converged ? 'Yes' : 'No'}`);
    lines.push(`  Improved: ${result.improved ? 'Yes' : 'No'}`);
    lines.push('');

    // Validation report
    lines.push(this.validationAgent.formatValidationResult(result.validation));

    // Final feedback
    if (result.feedback) {
      lines.push('FINAL FEEDBACK:');
      result.feedback.split('\n').forEach((line) => {
        lines.push(`  ${line}`);
      });
    }

    return lines.join('\n');
  }
}

export default ValidationLoop;
