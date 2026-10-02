/**
 * Requirement Checker - Extract and validate requirements from user input
 * Ensures outputs address all user requirements
 */

export interface Requirement {
  id: string;
  text: string;
  category: 'functional' | 'technical' | 'quality' | 'constraint';
  priority: 'critical' | 'important' | 'nice-to-have';
  keywords: string[];
}

export interface CoverageReport {
  totalRequirements: number;
  coveredRequirements: number;
  uncoveredRequirements: Requirement[];
  coveragePercentage: number;
  missingDetails: string[];
}

export class RequirementChecker {
  /**
   * Extract requirements from user request
   */
  async extractRequirements(userRequest: string): Promise<Requirement[]> {
    const requirements: Requirement[] = [];
    const id = 1;

    // Split request into sentences for analysis
    const sentences = userRequest
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const sentence of sentences) {
      const requirement = this.parseRequirement(sentence, id);
      if (requirement) {
        requirements.push(requirement);
      }
    }

    // If no structured requirements found, create a generic one
    if (requirements.length === 0) {
      requirements.push({
        id: `req_0`,
        text: userRequest,
        category: 'functional',
        priority: 'critical',
        keywords: this.extractKeywords(userRequest)
      });
    }

    return requirements;
  }

  /**
   * Check if output covers all requirements
   */
  async checkCoverage(
    requirements: Requirement[],
    output: string
  ): Promise<CoverageReport> {
    const coverageMap = new Map<string, boolean>();
    const uncoveredRequirements: Requirement[] = [];
    const missingDetails: string[] = [];

    for (const req of requirements) {
      const isCovered = this.isRequirementCovered(req, output);
      coverageMap.set(req.id, isCovered);

      if (!isCovered) {
        uncoveredRequirements.push(req);

        // Determine what's missing
        const missing = this.identifyMissingDetails(req, output);
        if (missing) {
          missingDetails.push(missing);
        }
      }
    }

    const coveredCount = Array.from(coverageMap.values()).filter(v => v).length;
    const coveragePercentage = requirements.length > 0
      ? (coveredCount / requirements.length) * 100
      : 100;

    return {
      totalRequirements: requirements.length,
      coveredRequirements: coveredCount,
      uncoveredRequirements,
      coveragePercentage,
      missingDetails
    };
  }

  /**
   * Get suggestions for improving coverage
   */
  async getSuggestions(
    requirements: Requirement[],
    output: string,
    coverage: CoverageReport
  ): Promise<string[]> {
    const suggestions: string[] = [];

    // If coverage is low, suggest addressing uncovered requirements
    if (coverage.coveragePercentage < 80) {
      for (const req of coverage.uncoveredRequirements) {
        suggestions.push(`Address requirement: "${req.text}"`);
      }
    }

    // Suggest adding examples if not present
    if (!output.includes('example') && !output.includes('Example')) {
      suggestions.push('Add examples to clarify the explanation');
    }

    // Suggest improving clarity if output is very dense
    const avgLineLength = output.split('\n').reduce((sum, line) => sum + line.length, 0) /
      output.split('\n').length;
    if (avgLineLength > 100) {
      suggestions.push('Break down long lines into smaller, clearer sentences');
    }

    // Suggest testing if code requirements exist
    const hasCodeRequirements = requirements.some(r =>
      r.keywords.includes('code') || r.keywords.includes('function')
    );
    if (hasCodeRequirements && !output.includes('test')) {
      suggestions.push('Add test cases to validate the code');
    }

    return suggestions;
  }

  // --- Private Helper Methods ---

  /**
   * Parse a single sentence into a requirement
   */
  private parseRequirement(sentence: string, id: number): Requirement | null {
    const keywords = this.extractKeywords(sentence);
    if (keywords.length === 0) return null;

    // Determine requirement type
    const category = this.determineCategory(sentence);
    const priority = this.determinePriority(sentence);

    return {
      id: `req_${id}`,
      text: sentence,
      category,
      priority,
      keywords
    };
  }

  /**
   * Extract key terms from text
   */
  private extractKeywords(text: string): string[] {
    const stopwords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'is', 'are', 'be', 'been', 'being', 'have', 'has', 'had',
      'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might',
      'must', 'can', 'please', 'thanks', 'thank', 'you', 'i', 'we', 'it'
    ]);

    return text
      .toLowerCase()
      .split(/\W+/)
      .filter(word => word.length > 2 && !stopwords.has(word))
      .slice(0, 10);
  }

  /**
   * Determine requirement category
   */
  private determineCategory(
    text: string
  ): Requirement['category'] {
    const lowerText = text.toLowerCase();

    if (
      lowerText.includes('make sure') ||
      lowerText.includes('ensure') ||
      lowerText.includes('validate') ||
      lowerText.includes('check')
    ) {
      return 'quality';
    }

    if (
      lowerText.includes('performance') ||
      lowerText.includes('speed') ||
      lowerText.includes('efficiency') ||
      lowerText.includes('optimize')
    ) {
      return 'technical';
    }

    if (
      lowerText.includes('must') ||
      lowerText.includes('should not') ||
      lowerText.includes('limited to')
    ) {
      return 'constraint';
    }

    return 'functional';
  }

  /**
   * Determine requirement priority
   */
  private determinePriority(
    text: string
  ): Requirement['priority'] {
    const lowerText = text.toLowerCase();

    if (
      lowerText.includes('must') ||
      lowerText.includes('critical') ||
      lowerText.includes('required') ||
      lowerText.includes('essential')
    ) {
      return 'critical';
    }

    if (
      lowerText.includes('should') ||
      lowerText.includes('important') ||
      lowerText.includes('needs')
    ) {
      return 'important';
    }

    return 'nice-to-have';
  }

  /**
   * Check if a requirement is addressed in output
   */
  private isRequirementCovered(requirement: Requirement, output: string): boolean {
    const lowerOutput = output.toLowerCase();

    // Check if any keywords appear in output
    const matchedKeywords = requirement.keywords.filter(keyword =>
      lowerOutput.includes(keyword.toLowerCase())
    );

    // At least 50% of keywords should match
    const keywordCoverage = matchedKeywords.length / Math.max(1, requirement.keywords.length);

    // For critical requirements, need higher coverage
    const threshold = requirement.priority === 'critical' ? 0.7 : 0.5;

    return keywordCoverage >= threshold;
  }

  /**
   * Identify what's missing in the output for a requirement
   */
  private identifyMissingDetails(requirement: Requirement, output: string): string | null {
    const matchedKeywords = requirement.keywords.filter(keyword =>
      output.toLowerCase().includes(keyword.toLowerCase())
    );

    const missingKeywords = requirement.keywords.filter(keyword =>
      !output.toLowerCase().includes(keyword.toLowerCase())
    );

    if (missingKeywords.length > 0) {
      return `Missing details about: ${missingKeywords.join(', ')}`;
    }

    return null;
  }
}

export default RequirementChecker;

