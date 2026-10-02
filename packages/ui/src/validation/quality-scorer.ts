/**
 * Quality Scorer - Multi-dimensional quality assessment
 * Scores outputs across completeness, clarity, accuracy, and correctness
 */

export interface QualityMetrics {
  completeness: number;     // 0-1: Does it cover all aspects?
  clarity: number;          // 0-1: Is it clear and well-organized?
  accuracy: number;         // 0-1: Is it technically correct?
  consistency: number;      // 0-1: Is it internally consistent?
  usability: number;        // 0-1: Is it practical to use?
  documentation: number;    // 0-1: Is it well-documented?
  overall: number;          // 0-1: Overall quality score
}

export interface QualityReport {
  metrics: QualityMetrics;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  qualityLevel: 'excellent' | 'good' | 'acceptable' | 'poor';
}

export class QualityScorer {
  /**
   * Score overall quality of output
   */
  async scoreOverall(
    request: string,
    output: string,
    outputType: 'code' | 'text' | 'analysis' = 'text'
  ): Promise<QualityReport> {
    const metrics = await this.calculateMetrics(request, output, outputType);
    const strengths = this.identifyStrengths(metrics, output);
    const weaknesses = this.identifyWeaknesses(metrics, output);
    const recommendations = this.generateRecommendations(weaknesses);
    const qualityLevel = this.getQualityLevel(metrics.overall);

    return {
      metrics,
      strengths,
      weaknesses,
      recommendations,
      qualityLevel
    };
  }

  /**
   * Calculate individual quality metrics
   */
  private async calculateMetrics(
    request: string,
    output: string,
    outputType: string
  ): Promise<QualityMetrics> {
    return {
      completeness: this.scoreCompleteness(request, output),
      clarity: this.scoreClarity(output),
      accuracy: this.scoreAccuracy(output, outputType),
      consistency: this.scoreConsistency(output),
      usability: this.scoreUsability(output, outputType),
      documentation: this.scoreDocumentation(output, outputType),
      overall: 0 // Will be calculated below
    };
  }

  /**
   * Score completeness: Does output address all aspects of the request?
   */
  private scoreCompleteness(request: string, output: string): number {
    let score = 0.5; // Start with neutral score

    // Extract key questions from request
    const questions = this.extractQuestions(request);

    // Check if output addresses each question
    let answeredQuestions = 0;
    for (const question of questions) {
      const keywords = question
        .toLowerCase()
        .split(/\W+/)
        .filter(w => w.length > 3);

      const addressedKeywords = keywords.filter(kw =>
        output.toLowerCase().includes(kw)
      );

      if (addressedKeywords.length >= keywords.length * 0.6) {
        answeredQuestions++;
      }
    }

    if (questions.length > 0) {
      const coverage = answeredQuestions / questions.length;
      score = Math.max(0.3, Math.min(1, coverage));
    }

    // Check if output has substantial length
    if (output.length < 50) {
      score *= 0.5; // Too short, incomplete
    } else if (output.length < 200) {
      score *= 0.75; // Somewhat short
    }

    return Math.round(score * 100) / 100;
  }

  /**
   * Score clarity: Is the output well-organized and easy to understand?
   */
  private scoreClarity(output: string): number {
    let score = 0.5;

    // Check structure
    const hasHeadings = /^#{1,6}\s+/m.test(output);
    if (hasHeadings) score += 0.15;

    const hasLists = /^[\s]*[-*+]\s+/m.test(output);
    if (hasLists) score += 0.1;

    const hasCodeBlocks = /```[\s\S]*?```/.test(output);
    if (hasCodeBlocks) score += 0.1;

    // Check paragraph length
    const paragraphs = output.split('\n\n').filter(p => p.trim());
    const avgParagraphLength = paragraphs.reduce((sum, p) => sum + p.length, 0) / Math.max(1, paragraphs.length);

    if (avgParagraphLength > 500) {
      score *= 0.75; // Too dense
    } else if (avgParagraphLength < 100 && paragraphs.length > 5) {
      score *= 1.1; // Good structure
    }

    // Check sentence length
    const sentences = output.match(/[.!?]+/g) || [];
    const avgSentenceLength = output.length / Math.max(1, sentences.length);

    if (avgSentenceLength > 150) {
      score *= 0.8; // Long sentences hurt clarity
    } else if (avgSentenceLength < 80) {
      score *= 1.1; // Short sentences help clarity
    }

    return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  }

  /**
   * Score accuracy: Is the content technically correct?
   */
  private scoreAccuracy(output: string, outputType: string): number {
    let score = 0.7; // Optimistic baseline

    // Check for common errors
    const errorPatterns = [
      /TODO|FIXME|XXX|HACK/gi,        // Incomplete implementations
      /undefined|null/gi,              // Possible null/undefined issues
      /error|fail|broken|bug/gi,       // Self-admitted issues
      /approximate|roughly|about/gi,   // Vague language suggesting uncertainty
      /i\s+think|i\s+guess|maybe/gi,  // Uncertain language
    ];

    for (const pattern of errorPatterns) {
      if (pattern.test(output)) {
        score -= 0.05;
      }
    }

    // Code-specific checks
    if (outputType === 'code') {
      // Check for balanced syntax
      const braceMatch = (output.match(/{/g) || []).length === (output.match(/}/g) || []).length;
      const parenMatch = (output.match(/\(/g) || []).length === (output.match(/\)/g) || []).length;

      if (!braceMatch || !parenMatch) {
        score -= 0.2; // Syntax error
      }

      // Check for proper naming conventions
      if (/[a-z]\d+[a-z]|_[a-z]{1,2}_/i.test(output)) {
        score += 0.05; // Good naming
      }
    }

    return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  }

  /**
   * Score consistency: Is the output internally consistent?
   */
  private scoreConsistency(output: string): number {
    let score = 0.7;

    // Check for contradictory statements
    const lines = output.split('\n');
    const claims = new Map<string, number>();

    for (const line of lines) {
      // Simple heuristic: if same key term appears with different modifiers
      const keywords = line.toLowerCase().match(/\b\w+\b/g) || [];
      for (const keyword of keywords) {
        claims.set(keyword, (claims.get(keyword) || 0) + 1);
      }
    }

    // Check for excessive keyword repetition (might indicate inconsistency)
    let repetitionScore = 1;
    for (const count of claims.values()) {
      if (count > output.split(/\s+/).length * 0.1) {
        repetitionScore *= 0.95;
      }
    }
    score *= repetitionScore;

    // Check for consistent formatting
    const hasConsistentFormatting = /^```[\s\S]*?```/.test(output) &&
      /^```[\s\S]*?```/.test(output.slice(output.indexOf('```') + 3));
    if (hasConsistentFormatting) {
      score += 0.1;
    }

    return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  }

  /**
   * Score usability: Is the output practical to use?
   */
  private scoreUsability(output: string, outputType: string): number {
    let score = 0.6;

    if (outputType === 'code') {
      // Check for examples
      if (/example|usage|demo/i.test(output)) {
        score += 0.15;
      }

      // Check for comments
      const commentRatio = (output.match(/\/\//g) || []).length / output.split('\n').length;
      if (commentRatio > 0.1) {
        score += 0.1;
      }

      // Check for imports/dependencies clarity
      if (/^import|^from|^require/m.test(output)) {
        score += 0.05;
      }
    } else {
      // Text output
      // Check for actionable items
      if (/step|next|follow|implement|try/i.test(output)) {
        score += 0.15;
      }

      // Check for examples
      if (/example|for instance|such as/i.test(output)) {
        score += 0.1;
      }

      // Check for structure (bullet points, numbered lists)
      if (/^[\s]*\d+\.|^[\s]*[-*]/m.test(output)) {
        score += 0.05;
      }
    }

    return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  }

  /**
   * Score documentation: Is the output well-documented?
   */
  private scoreDocumentation(output: string, outputType: string): number {
    let score = 0.4;

    // Check for comments/explanations
    const docPatterns = [
      /\/\//g,           // Single-line comments
      /\/\*[\s\S]*?\*\//g, // Multi-line comments
      /"""|'''/g,        // Python docstrings
      /\/\*\*/g,         // JSDoc markers
    ];

    const docCount = docPatterns.reduce((sum, pattern) => {
      return sum + (output.match(pattern) || []).length;
    }, 0);

    const docDensity = docCount / Math.max(1, output.split('\n').length);
    if (docDensity > 0.1) {
      score += 0.3;
    } else if (docDensity > 0.05) {
      score += 0.2;
    }

    // Check for descriptive text
    if (/description|purpose|note|important|warning/i.test(output)) {
      score += 0.2;
    }

    return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  }

  // --- Helper Methods ---

  private extractQuestions(text: string): string[] {
    return text
      .split(/[.!?]+/)
      .filter(s => s.toLowerCase().includes('what') ||
                   s.toLowerCase().includes('how') ||
                   s.toLowerCase().includes('why') ||
                   s.toLowerCase().includes('can') ||
                   s.toLowerCase().includes('should') ||
                   s.toLowerCase().includes('?'))
      .slice(0, 10);
  }

  private identifyStrengths(metrics: QualityMetrics, output: string): string[] {
    const strengths: string[] = [];

    if (metrics.clarity > 0.8) {
      strengths.push('Well-organized and clear structure');
    }

    if (metrics.completeness > 0.8) {
      strengths.push('Comprehensive coverage of the topic');
    }

    if (metrics.accuracy > 0.85) {
      strengths.push('Technically accurate content');
    }

    if (metrics.documentation > 0.7) {
      strengths.push('Well-documented with examples');
    }

    if (output.length > 500) {
      strengths.push('Detailed and thorough response');
    }

    return strengths;
  }

  private identifyWeaknesses(metrics: QualityMetrics, output: string): string[] {
    const weaknesses: string[] = [];

    if (metrics.completeness < 0.7) {
      weaknesses.push('Incomplete coverage of requirements');
    }

    if (metrics.clarity < 0.7) {
      weaknesses.push('Could be clearer or better organized');
    }

    if (metrics.accuracy < 0.75) {
      weaknesses.push('Potential accuracy issues detected');
    }

    if (metrics.documentation < 0.6) {
      weaknesses.push('Lacks documentation or examples');
    }

    if (output.length < 100) {
      weaknesses.push('Too brief, needs more detail');
    }

    return weaknesses;
  }

  private generateRecommendations(weaknesses: string[]): string[] {
    const recommendations: string[] = [];

    for (const weakness of weaknesses) {
      if (weakness.includes('Incomplete')) {
        recommendations.push('Add missing sections or details');
      }
      if (weakness.includes('clearer')) {
        recommendations.push('Reorganize content with clearer structure');
      }
      if (weakness.includes('accuracy')) {
        recommendations.push('Verify technical accuracy and correct errors');
      }
      if (weakness.includes('documentation')) {
        recommendations.push('Add code comments, docstrings, or examples');
      }
      if (weakness.includes('brief')) {
        recommendations.push('Expand with more detailed explanations');
      }
    }

    return [...new Set(recommendations)]; // Remove duplicates
  }

  private getQualityLevel(overallScore: number): QualityReport['qualityLevel'] {
    if (overallScore >= 0.85) return 'excellent';
    if (overallScore >= 0.7) return 'good';
    if (overallScore >= 0.55) return 'acceptable';
    return 'poor';
  }
}

export default QualityScorer;

