/**
 * Validation Agent - Orchestrates multi-dimensional output validation
 * Combines requirement checking, code validation, and quality scoring
 */

import {
  RequirementChecker,
  type Requirement,
  type CoverageReport,
} from '../validation/requirement-checker.js';
import {
  CodeValidator,
  type CodeValidationResult,
  type ValidationIssue,
} from '../validation/code-validator.js';
import { QualityScorer, type QualityReport } from '../validation/quality-scorer.js';

export interface ValidationSummary {
  passed: boolean;
  confidence: number; // 0-1: Overall validation confidence
  overallScore: number; // 0-100: Weighted quality score
  requirementsCoverage: number; // 0-1: Requirements coverage percentage
  codeQualityScore: number; // 0-100: Code validation score (if applicable)
  contentQualityScore: number; // 0-1: Multi-dimensional quality score

  // Detailed results
  requirements: {
    total: number;
    covered: number;
    uncovered: Requirement[];
    missingDetails: string[];
  };

  codeValidation?: {
    isValid: boolean;
    criticalIssues: ValidationIssue[];
    warnings: ValidationIssue[];
    infos: ValidationIssue[];
  };

  quality: {
    level: 'excellent' | 'good' | 'acceptable' | 'poor';
    metrics: {
      completeness: number;
      clarity: number;
      accuracy: number;
      consistency: number;
      usability: number;
      documentation: number;
    };
    strengths: string[];
    weaknesses: string[];
    recommendations: string[];
  };

  // Aggregated issues and suggestions
  criticalIssues: string[];
  warnings: string[];
  suggestions: string[];
}

export class ValidationAgent {
  private requirementChecker: RequirementChecker;
  private codeValidator: CodeValidator;
  private qualityScorer: QualityScorer;

  constructor() {
    this.requirementChecker = new RequirementChecker();
    this.codeValidator = new CodeValidator();
    this.qualityScorer = new QualityScorer();
  }

  /**
   * Validate output against user requirements
   * Combines requirement coverage, code quality, and content quality
   */
  async validate(
    userRequest: string,
    output: string,
    outputType: 'code' | 'text' | 'analysis' = 'text'
  ): Promise<ValidationSummary> {
    // Extract and check requirements
    const requirements = await this.requirementChecker.extractRequirements(userRequest);
    const coverageReport = await this.requirementChecker.checkCoverage(requirements, output);
    const requirementsSuggestions = await this.requirementChecker.getSuggestions(
      requirements,
      output,
      coverageReport
    );

    // Validate code if applicable
    let codeValidationResult: CodeValidationResult | null = null;
    if (outputType === 'code') {
      codeValidationResult = await this.codeValidator.validateComprehensive(output, 'typescript');
    }

    // Score overall quality
    const qualityReport = await this.qualityScorer.scoreOverall(userRequest, output, outputType);

    // Aggregate results
    return this.aggregateResults(
      coverageReport,
      codeValidationResult,
      qualityReport,
      requirementsSuggestions
    );
  }

  /**
   * Validate multiple outputs and return best result
   */
  async validateMultiple(
    userRequest: string,
    outputs: Array<{ content: string; type?: 'code' | 'text' | 'analysis' }>,
    selectBest: boolean = true
  ): Promise<{
    results: ValidationSummary[];
    best?: ValidationSummary;
    bestIndex?: number;
  }> {
    const results = await Promise.all(
      outputs.map((output) => this.validate(userRequest, output.content, output.type || 'text'))
    );

    if (selectBest && results.length > 0) {
      let bestIndex = 0;
      let bestScore = results[0].confidence;

      for (let i = 1; i < results.length; i++) {
        if (results[i].confidence > bestScore) {
          bestScore = results[i].confidence;
          bestIndex = i;
        }
      }

      return {
        results,
        best: results[bestIndex],
        bestIndex,
      };
    }

    return { results };
  }

  /**
   * Aggregate validation results from all validators
   */
  private aggregateResults(
    coverage: CoverageReport,
    codeValidation: CodeValidationResult | null,
    quality: QualityReport,
    requirementsSuggestions: string[]
  ): ValidationSummary {
    const criticalIssues: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [...requirementsSuggestions];

    // Extract critical issues from code validation
    let codeValidationAggregated = null;
    if (codeValidation) {
      const criticals = codeValidation.issues.filter((i) => i.severity === 'critical');
      const warns = codeValidation.issues.filter((i) => i.severity === 'warning');
      const infos = codeValidation.issues.filter((i) => i.severity === 'info');

      if (criticals.length > 0) {
        criticalIssues.push(`Code has ${criticals.length} critical issue(s)`);
      }

      if (warns.length > 0) {
        warnings.push(`Code has ${warns.length} warning(s)`);
        warns.slice(0, 3).forEach((w) => suggestions.push(w.suggestion || w.description));
      }

      codeValidationAggregated = {
        isValid: codeValidation.isValid,
        criticalIssues: criticals,
        warnings: warns,
        infos,
      };
    }

    // Extract requirements issues
    if (coverage.uncoveredRequirements.length > 0) {
      const uncovered = coverage.uncoveredRequirements.filter((r) => r.priority === 'critical');
      if (uncovered.length > 0) {
        criticalIssues.push(`${uncovered.length} critical requirement(s) not addressed`);
      }
    }

    if (coverage.missingDetails.length > 0) {
      suggestions.push(...coverage.missingDetails.slice(0, 3));
    }

    // Extract quality issues
    quality.weaknesses.forEach((w) => {
      if (w.includes('accuracy') || w.includes('critical') || w.includes('Incomplete coverage')) {
        criticalIssues.push(w);
      } else {
        warnings.push(w);
      }
    });

    // Calculate confidence score
    // Based on: requirements coverage (30%), code quality (30% if applicable), content quality (40%)
    let confidence: number;
    const requirementConfidence = coverage.coveragePercentage / 100;
    const codeConfidence = codeValidation
      ? Math.max(0, 1 - (codeValidation.criticalCount * 0.25 + codeValidation.warningCount * 0.05))
      : 0;
    const qualityConfidence = quality.metrics.overall;

    if (codeValidation) {
      const weights = { requirements: 0.3, code: 0.3, quality: 0.4 };
      confidence =
        requirementConfidence * weights.requirements +
        codeConfidence * weights.code +
        qualityConfidence * weights.quality;
    } else {
      const weights = { requirements: 0.4, quality: 0.6 };
      confidence =
        requirementConfidence * weights.requirements + qualityConfidence * weights.quality;
    }

    confidence = Math.max(0, Math.min(1, confidence));

    // Calculate weighted overall score (0-100)
    const codeScore = codeValidation ? codeValidation.score : 100;
    const qualityScore = quality.metrics.overall * 100;
    const requirementScore = coverage.coveragePercentage;

    let overallScore: number;
    if (codeValidation) {
      overallScore = requirementScore * 0.3 + codeScore * 0.3 + qualityScore * 0.4;
    } else {
      overallScore = requirementScore * 0.4 + qualityScore * 0.6;
    }

    return {
      passed: criticalIssues.length === 0 && confidence >= 0.8,
      confidence: Math.round(confidence * 100) / 100,
      overallScore: Math.round(overallScore),
      requirementsCoverage: Math.round(coverage.coveragePercentage) / 100,
      codeQualityScore: codeValidation ? codeValidation.score : 100,
      contentQualityScore: quality.metrics.overall,

      requirements: {
        total: coverage.totalRequirements,
        covered: coverage.coveredRequirements,
        uncovered: coverage.uncoveredRequirements,
        missingDetails: coverage.missingDetails,
      },

      codeValidation: codeValidationAggregated ?? undefined,

      quality: {
        level: quality.qualityLevel,
        metrics: quality.metrics,
        strengths: quality.strengths,
        weaknesses: quality.weaknesses,
        recommendations: quality.recommendations,
      },

      criticalIssues,
      warnings,
      suggestions: [...new Set(suggestions)], // Remove duplicates
    };
  }

  /**
   * Get validation summary as formatted string
   */
  formatValidationResult(result: ValidationSummary): string {
    const lines: string[] = [];

    lines.push('=== VALIDATION REPORT ===');
    lines.push(`Status: ${result.passed ? 'PASSED' : 'NEEDS IMPROVEMENT'}`);
    lines.push(`Confidence: ${(result.confidence * 100).toFixed(1)}%`);
    lines.push(`Overall Score: ${result.overallScore}/100`);
    lines.push('');

    // Requirements
    lines.push('REQUIREMENTS:');
    lines.push(
      `  Coverage: ${result.requirements.covered}/${result.requirements.total} (${Math.round(result.requirementsCoverage * 100)}%)`
    );
    if (result.requirements.uncovered.length > 0) {
      lines.push(`  Uncovered: ${result.requirements.uncovered.map((r) => r.text).join(', ')}`);
    }
    lines.push('');

    // Code Validation
    if (result.codeValidation) {
      lines.push('CODE VALIDATION:');
      lines.push(`  Status: ${result.codeValidation.isValid ? 'Valid' : 'Has Issues'}`);
      lines.push(`  Critical: ${result.codeValidation.criticalIssues.length}`);
      lines.push(`  Warnings: ${result.codeValidation.warnings.length}`);
      lines.push(`  Score: ${result.codeQualityScore}/100`);
      lines.push('');
    }

    // Quality
    lines.push('QUALITY METRICS:');
    lines.push(`  Completeness: ${(result.quality.metrics.completeness * 100).toFixed(0)}%`);
    lines.push(`  Clarity: ${(result.quality.metrics.clarity * 100).toFixed(0)}%`);
    lines.push(`  Accuracy: ${(result.quality.metrics.accuracy * 100).toFixed(0)}%`);
    lines.push(`  Consistency: ${(result.quality.metrics.consistency * 100).toFixed(0)}%`);
    lines.push(`  Usability: ${(result.quality.metrics.usability * 100).toFixed(0)}%`);
    lines.push(`  Documentation: ${(result.quality.metrics.documentation * 100).toFixed(0)}%`);
    lines.push(`  Level: ${result.quality.level.toUpperCase()}`);
    lines.push('');

    // Strengths
    if (result.quality.strengths.length > 0) {
      lines.push('STRENGTHS:');
      result.quality.strengths.forEach((s) => {
        lines.push(`  + ${s}`);
      });
      lines.push('');
    }

    // Issues
    if (result.criticalIssues.length > 0) {
      lines.push('CRITICAL ISSUES:');
      result.criticalIssues.forEach((issue) => {
        lines.push(`  ! ${issue}`);
      });
      lines.push('');
    }

    if (result.warnings.length > 0) {
      lines.push('WARNINGS:');
      result.warnings.forEach((warning) => {
        lines.push(`  - ${warning}`);
      });
      lines.push('');
    }

    // Suggestions
    if (result.suggestions.length > 0) {
      lines.push('RECOMMENDATIONS:');
      result.suggestions.forEach((suggestion) => {
        lines.push(`  → ${suggestion}`);
      });
      lines.push('');
    }

    return lines.join('\n');
  }
}

export default ValidationAgent;

