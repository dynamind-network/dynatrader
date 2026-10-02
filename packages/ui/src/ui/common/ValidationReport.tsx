import React from 'react';
import { Box, Text } from '@dynatrader/ink/terminal';
import type { ValidationSummary } from '../../index.js';

interface ValidationReportProps {
  validation: ValidationSummary;
  showDetails?: boolean;
}

/**
 * Display validation results in the terminal
 * Shows confidence score, quality metrics, issues, and recommendations
 */
export function ValidationReport({ validation, showDetails = true }: ValidationReportProps) {
  const getStatusColor = (passed: boolean, confidence: number): string => {
    if (passed) return 'green';
    if (confidence >= 0.7) return 'yellow';
    return 'red';
  };

  const getScoreColor = (score: number): string => {
    if (score >= 85) return 'green';
    if (score >= 70) return 'yellow';
    if (score >= 55) return 'cyan';
    return 'red';
  };

  const getMetricBar = (value: number, width: number = 20): string => {
    const filled = Math.round((value * width) / 100);
    const empty = width - filled;
    return '[' + '='.repeat(filled) + ' '.repeat(empty) + ']';
  };

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} paddingX={1}>
      {/* Status header */}
      <Box marginBottom={1}>
        <Text color={getStatusColor(validation.passed, validation.confidence)} bold>
          VALIDATION: {validation.passed ? 'PASSED' : 'NEEDS IMPROVEMENT'}
        </Text>
        <Text> | </Text>
        <Text color="white">Confidence: {(validation.confidence * 100).toFixed(1)}%</Text>
        <Text> | </Text>
        <Text color={getScoreColor(validation.overallScore)}>
          Score: {validation.overallScore}/100
        </Text>
      </Box>

      {/* Requirements coverage */}
      <Box>
        <Box width={25}>
          <Text>Requirements:</Text>
        </Box>
        <Text color={validation.requirementsCoverage >= 0.9 ? 'green' : 'yellow'}>
          {validation.requirements.covered}/{validation.requirements.total}
        </Text>
        <Text> {getMetricBar(validation.requirementsCoverage * 100)}</Text>
      </Box>

      {/* Quality metrics (collapsed view) */}
      {showDetails && (
        <Box flexDirection="column" marginY={1} paddingX={2}>
          <Text bold color="blue">
            Quality Metrics:
          </Text>

          {/* Completeness */}
          <Box marginY={0.5}>
            <Box width={18}>
              <Text> Completeness:</Text>
            </Box>
            <Text color={validation.quality.metrics.completeness >= 0.8 ? 'green' : 'yellow'}>
              {(validation.quality.metrics.completeness * 100).toFixed(0)}%
            </Text>
            <Text> {getMetricBar(validation.quality.metrics.completeness * 100, 15)}</Text>
          </Box>

          {/* Clarity */}
          <Box marginY={0.5}>
            <Box width={18}>
              <Text> Clarity:</Text>
            </Box>
            <Text color={validation.quality.metrics.clarity >= 0.8 ? 'green' : 'yellow'}>
              {(validation.quality.metrics.clarity * 100).toFixed(0)}%
            </Text>
            <Text> {getMetricBar(validation.quality.metrics.clarity * 100, 15)}</Text>
          </Box>

          {/* Accuracy */}
          <Box marginY={0.5}>
            <Box width={18}>
              <Text> Accuracy:</Text>
            </Box>
            <Text color={validation.quality.metrics.accuracy >= 0.8 ? 'green' : 'yellow'}>
              {(validation.quality.metrics.accuracy * 100).toFixed(0)}%
            </Text>
            <Text> {getMetricBar(validation.quality.metrics.accuracy * 100, 15)}</Text>
          </Box>

          {/* Consistency */}
          <Box marginY={0.5}>
            <Box width={18}>
              <Text> Consistency:</Text>
            </Box>
            <Text color={validation.quality.metrics.consistency >= 0.8 ? 'green' : 'yellow'}>
              {(validation.quality.metrics.consistency * 100).toFixed(0)}%
            </Text>
            <Text> {getMetricBar(validation.quality.metrics.consistency * 100, 15)}</Text>
          </Box>

          {/* Usability */}
          <Box marginY={0.5}>
            <Box width={18}>
              <Text> Usability:</Text>
            </Box>
            <Text color={validation.quality.metrics.usability >= 0.8 ? 'green' : 'yellow'}>
              {(validation.quality.metrics.usability * 100).toFixed(0)}%
            </Text>
            <Text> {getMetricBar(validation.quality.metrics.usability * 100, 15)}</Text>
          </Box>

          {/* Documentation */}
          <Box marginY={0.5}>
            <Box width={18}>
              <Text> Documentation:</Text>
            </Box>
            <Text color={validation.quality.metrics.documentation >= 0.8 ? 'green' : 'yellow'}>
              {(validation.quality.metrics.documentation * 100).toFixed(0)}%
            </Text>
            <Text> {getMetricBar(validation.quality.metrics.documentation * 100, 15)}</Text>
          </Box>

          {/* Quality level */}
          <Box marginY={1}>
            <Box width={18}>
              <Text> Overall Level:</Text>
            </Box>
            <Text
              color={
                validation.quality.level === 'excellent'
                  ? 'green'
                  : validation.quality.level === 'good'
                    ? 'cyan'
                    : validation.quality.level === 'acceptable'
                      ? 'yellow'
                      : 'red'
              }
              bold
            >
              {validation.quality.level.toUpperCase()}
            </Text>
          </Box>
        </Box>
      )}

      {/* Strengths */}
      {showDetails && validation.quality.strengths.length > 0 && (
        <Box flexDirection="column" marginY={1} paddingX={2}>
          <Text bold color="green">
            Strengths:
          </Text>
          {validation.quality.strengths.slice(0, 3).map((strength, i) => (
            <Text key={i} color="green">
              + {strength}
            </Text>
          ))}
        </Box>
      )}

      {/* Critical issues */}
      {validation.criticalIssues.length > 0 && (
        <Box flexDirection="column" marginY={1} paddingX={2}>
          <Text bold color="red">
            Critical Issues ({validation.criticalIssues.length}):
          </Text>
          {validation.criticalIssues.slice(0, 3).map((issue, i) => (
            <Text key={i} color="red">
              ! {issue}
            </Text>
          ))}
          {validation.criticalIssues.length > 3 && (
            <Text color="red">... and {validation.criticalIssues.length - 3} more</Text>
          )}
        </Box>
      )}

      {/* Warnings */}
      {validation.warnings.length > 0 && (
        <Box flexDirection="column" marginY={1} paddingX={2}>
          <Text bold color="yellow">
            Warnings ({validation.warnings.length}):
          </Text>
          {validation.warnings.slice(0, 2).map((warning, i) => (
            <Text key={i} color="yellow">
              - {warning}
            </Text>
          ))}
          {validation.warnings.length > 2 && (
            <Text color="yellow">... and {validation.warnings.length - 2} more</Text>
          )}
        </Box>
      )}

      {/* Suggestions */}
      {showDetails && validation.suggestions.length > 0 && (
        <Box flexDirection="column" marginY={1} paddingX={2}>
          <Text bold color="cyan">
            Recommendations:
          </Text>
          {validation.suggestions.slice(0, 3).map((suggestion, i) => (
            <Text key={i} color="cyan">
              → {suggestion}
            </Text>
          ))}
          {validation.suggestions.length > 3 && (
            <Text color="cyan">... and {validation.suggestions.length - 3} more</Text>
          )}
        </Box>
      )}

      {/* Uncovered requirements */}
      {validation.requirements.uncovered.length > 0 && (
        <Box flexDirection="column" marginY={1} paddingX={2}>
          <Text bold color="yellow">
            Uncovered Requirements ({validation.requirements.uncovered.length}):
          </Text>
          {validation.requirements.uncovered.slice(0, 2).map((req, i) => (
            <Text key={i} color="yellow">
              - [{req.priority}] {req.text}
            </Text>
          ))}
          {validation.requirements.uncovered.length > 2 && (
            <Text color="yellow">... and {validation.requirements.uncovered.length - 2} more</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

/**
 * Compact validation summary for inline display
 */
export function ValidationSummary({ validation }: ValidationReportProps) {
  const statusEmoji = validation.passed ? 'PASS' : 'FAIL';
  const statusColor = validation.passed ? 'green' : 'red';

  return (
    <Box>
      <Text color={statusColor} bold>
        [{statusEmoji}]
      </Text>
      <Text> Validation: </Text>
      <Text color={statusColor}>{(validation.confidence * 100).toFixed(0)}%</Text>
      <Text> | </Text>
      <Text>{validation.overallScore}/100</Text>
      {validation.criticalIssues.length > 0 && (
        <>
          <Text> | </Text>
          <Text color="red">{validation.criticalIssues.length} critical</Text>
        </>
      )}
    </Box>
  );
}

export default ValidationReport;

