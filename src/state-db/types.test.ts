/**
 * Tests for StateDb type definitions
 */

import { describe, it, expect } from 'vitest';
import type {
  SessionRow,
  MessageRow,
  GoalRow,
  GoalStepRow,
  CronJobRow,
  CronStateRow,
  TradeRow,
  PositionRow,
  PortfolioSnapshotRow,
  PriceCacheRow,
  StateMetaRow,
} from './types';

describe('StateDb Types', () => {
  describe('SessionRow', () => {
    it('should create a valid session row', () => {
      const row: SessionRow = {
        id: 'session_001',
        agent_id: 'agent_alpha',
        platform: 'telegram',
        platform_user_id: 'user_42',
        status: 'active',
        metadata: '{"timezone":"UTC","language":"en"}',
        created_at: 1700000000000,
        updated_at: 1700000100000,
      };

      expect(row.id).toBe('session_001');
      expect(row.agent_id).toBe('agent_alpha');
      expect(row.platform).toBe('telegram');
      expect(row.platform_user_id).toBe('user_42');
      expect(row.status).toBe('active');
      expect(row.metadata).toBe('{"timezone":"UTC","language":"en"}');
      expect(row.created_at).toBe(1700000000000);
      expect(row.updated_at).toBe(1700000100000);
      expect(typeof row.created_at).toBe('number');
      expect(typeof row.updated_at).toBe('number');
    });

    it('should accept all status values', () => {
      const active: SessionRow['status'] = 'active';
      const idle: SessionRow['status'] = 'idle';
      const closed: SessionRow['status'] = 'closed';

      expect([active, idle, closed]).toContain('active');
      expect([active, idle, closed]).toContain('idle');
      expect([active, idle, closed]).toContain('closed');
    });
  });

  describe('MessageRow', () => {
    it('should create a valid message row', () => {
      const row: MessageRow = {
        id: 'msg_001',
        session_id: 'session_001',
        role: 'user',
        content: 'What is the price of BTC?',
        tool_calls: null,
        tool_results: null,
        token_count: 42,
        created_at: 1700000000000,
      };

      expect(row.id).toBe('msg_001');
      expect(row.session_id).toBe('session_001');
      expect(row.role).toBe('user');
      expect(row.content).toBe('What is the price of BTC?');
      expect(row.tool_calls).toBeNull();
      expect(row.tool_results).toBeNull();
      expect(row.token_count).toBe(42);
      expect(row.created_at).toBe(1700000000000);
    });

    it('should accept all role values', () => {
      const user: MessageRow['role'] = 'user';
      const assistant: MessageRow['role'] = 'assistant';
      const system: MessageRow['role'] = 'system';
      const tool: MessageRow['role'] = 'tool';

      expect([user, assistant, system, tool]).toHaveLength(4);
    });

    it('should accept tool_calls and tool_results as JSON strings', () => {
      const row: MessageRow = {
        id: 'msg_002',
        session_id: 'session_001',
        role: 'assistant',
        content: 'Let me check the price.',
        tool_calls: '[{"name":"get_price","args":{"symbol":"BTC"}}]',
        tool_results: '[{"result":50000}]',
        token_count: 55,
        created_at: 1700000000000,
      };

      expect(row.tool_calls).toBe('[{"name":"get_price","args":{"symbol":"BTC"}}]');
      expect(row.tool_results).toBe('[{"result":50000}]');
    });
  });

  describe('GoalRow', () => {
    it('should create a valid goal row', () => {
      const row: GoalRow = {
        id: 'goal_001',
        session_id: 'session_001',
        title: 'Analyze BTC trend',
        description: 'Perform technical analysis on BTC/USDT',
        status: 'active',
        claims: '["claim_1","claim_2"]',
        evidence: '["ev_1","ev_2"]',
        budget: '{"max_steps":5,"max_tokens":2000}',
        completion_policy: '{"type":"all_claims_verified"}',
        created_at: 1700000000000,
        updated_at: 1700000100000,
      };

      expect(row.id).toBe('goal_001');
      expect(row.session_id).toBe('session_001');
      expect(row.title).toBe('Analyze BTC trend');
      expect(row.description).toBe('Perform technical analysis on BTC/USDT');
      expect(row.status).toBe('active');
      expect(row.claims).toBe('["claim_1","claim_2"]');
      expect(row.evidence).toBe('["ev_1","ev_2"]');
      expect(row.budget).toBe('{"max_steps":5,"max_tokens":2000}');
      expect(row.completion_policy).toBe('{"type":"all_claims_verified"}');
      expect(row.created_at).toBe(1700000000000);
      expect(row.updated_at).toBe(1700000100000);
    });

    it('should accept all status values', () => {
      const active: GoalRow['status'] = 'active';
      const completed: GoalRow['status'] = 'completed';
      const failed: GoalRow['status'] = 'failed';
      const paused: GoalRow['status'] = 'paused';

      expect([active, completed, failed, paused]).toHaveLength(4);
    });
  });

  describe('GoalStepRow', () => {
    it('should create a valid goal step row', () => {
      const row: GoalStepRow = {
        id: 'step_001',
        goal_id: 'goal_001',
        title: 'Fetch price data',
        description: 'Get OHLCV data from exchange',
        order: 1,
        status: 'in_progress',
        depends_on: '["step_000"]',
        assignable_tools: '["fetch_price","calculate_rsi"]',
        budget: '{"max_tokens":500}',
        output: null,
        completed_at: null,
        created_at: 1700000000000,
        updated_at: 1700000100000,
      };

      expect(row.id).toBe('step_001');
      expect(row.goal_id).toBe('goal_001');
      expect(row.title).toBe('Fetch price data');
      expect(row.description).toBe('Get OHLCV data from exchange');
      expect(row.order).toBe(1);
      expect(row.status).toBe('in_progress');
      expect(row.depends_on).toBe('["step_000"]');
      expect(row.assignable_tools).toBe('["fetch_price","calculate_rsi"]');
      expect(row.budget).toBe('{"max_tokens":500}');
      expect(row.output).toBeNull();
      expect(row.completed_at).toBeNull();
      expect(row.created_at).toBe(1700000000000);
      expect(row.updated_at).toBe(1700000100000);
    });

    it('should accept nullable assignable_tools', () => {
      const row: GoalStepRow = {
        id: 'step_002',
        goal_id: 'goal_001',
        title: 'Analyze',
        description: 'Analyze the data',
        order: 2,
        status: 'pending',
        depends_on: '["step_001"]',
        assignable_tools: null,
        budget: '{}',
        output: 'Analysis complete',
        completed_at: 1700000200000,
        created_at: 1700000000000,
        updated_at: 1700000200000,
      };

      expect(row.assignable_tools).toBeNull();
      expect(row.output).toBe('Analysis complete');
      expect(row.completed_at).toBe(1700000200000);
    });

    it('should accept all status values', () => {
      const pending: GoalStepRow['status'] = 'pending';
      const inProgress: GoalStepRow['status'] = 'in_progress';
      const completed: GoalStepRow['status'] = 'completed';
      const blocked: GoalStepRow['status'] = 'blocked';
      const failed: GoalStepRow['status'] = 'failed';

      expect([pending, inProgress, completed, blocked, failed]).toHaveLength(5);
    });
  });

  describe('CronJobRow', () => {
    it('should create a valid cron job row', () => {
      const row: CronJobRow = {
        id: 'cron_001',
        name: 'BTC Price Check',
        prompt: 'Check BTC price and report',
        command: null,
        schedule_kind: 'interval',
        schedule_display: 'Every 5 minutes',
        schedule_interval_ms: 300000,
        schedule_expression: null,
        schedule_run_at: null,
        skills: '["price_check","reporting"]',
        deliver: '{"channels":["telegram"]}',
        enabled: 1,
        state: 'scheduled',
        last_status: 'ok',
        last_error: null,
        repeat_count: null,
        completed_runs: 42,
        tags: '["btc","price","automated"]',
        pipeline: null,
        approval_status: null,
        execution_policy: null,
        wake_agent: 1,
        context_from: null,
        allowed_tools: null,
        disallowed_tools: null,
        model_config: null,
        created_at: 1700000000000,
        updated_at: 1700000100000,
      };

      expect(row.id).toBe('cron_001');
      expect(row.name).toBe('BTC Price Check');
      expect(row.prompt).toBe('Check BTC price and report');
      expect(row.command).toBeNull();
      expect(row.schedule_kind).toBe('interval');
      expect(row.schedule_display).toBe('Every 5 minutes');
      expect(row.schedule_interval_ms).toBe(300000);
      expect(row.schedule_expression).toBeNull();
      expect(row.schedule_run_at).toBeNull();
      expect(row.skills).toBe('["price_check","reporting"]');
      expect(row.deliver).toBe('{"channels":["telegram"]}');
      expect(row.enabled).toBe(1);
      expect(row.state).toBe('scheduled');
      expect(row.last_status).toBe('ok');
      expect(row.last_error).toBeNull();
      expect(row.repeat_count).toBeNull();
      expect(row.completed_runs).toBe(42);
      expect(row.tags).toBe('["btc","price","automated"]');
      expect(row.pipeline).toBeNull();
      expect(row.approval_status).toBeNull();
      expect(row.execution_policy).toBeNull();
      expect(row.wake_agent).toBe(1);
      expect(row.context_from).toBeNull();
      expect(row.allowed_tools).toBeNull();
      expect(row.disallowed_tools).toBeNull();
      expect(row.model_config).toBeNull();
      expect(row.created_at).toBe(1700000000000);
      expect(row.updated_at).toBe(1700000100000);
    });

    it('should accept last_status with null', () => {
      const row: CronJobRow = {
        id: 'cron_002',
        name: 'Failed Check',
        prompt: null,
        command: 'echo hello',
        schedule_kind: 'once',
        schedule_display: 'Once at startup',
        schedule_interval_ms: null,
        schedule_expression: null,
        schedule_run_at: 1700000000000,
        skills: '[]',
        deliver: '{}',
        enabled: 0,
        state: 'paused',
        last_status: null,
        last_error: 'Something went wrong',
        repeat_count: 1,
        completed_runs: 0,
        tags: '[]',
        pipeline: null,
        approval_status: null,
        execution_policy: null,
        wake_agent: 0,
        context_from: null,
        allowed_tools: null,
        disallowed_tools: null,
        model_config: null,
        created_at: 1700000000000,
        updated_at: 1700000100000,
      };

      expect(row.last_status).toBeNull();
      expect(row.last_error).toBe('Something went wrong');
      expect(row.enabled).toBe(0);
      expect(row.wake_agent).toBe(0);
      expect(row.state).toBe('paused');
    });

    it('should accept all schedule_kind values', () => {
      const once: CronJobRow['schedule_kind'] = 'once';
      const interval: CronJobRow['schedule_kind'] = 'interval';
      const cron: CronJobRow['schedule_kind'] = 'cron';

      expect([once, interval, cron]).toHaveLength(3);
    });

    it('should accept all state values', () => {
      const scheduled: CronJobRow['state'] = 'scheduled';
      const paused: CronJobRow['state'] = 'paused';
      const running: CronJobRow['state'] = 'running';
      const completed: CronJobRow['state'] = 'completed';

      expect([scheduled, paused, running, completed]).toHaveLength(4);
    });
  });

  describe('CronStateRow', () => {
    it('should create a valid cron state row', () => {
      const row: CronStateRow = {
        id: 'cron_state_001',
        job_id: 'cron_001',
        version: 3,
        session_id: 'session_001',
        prompt_fingerprint: 'abc123def',
        summary: 'BTC price is $50,000',
        last_output: 'Price check complete',
        last_trade: '{"symbol":"BTC","side":"long","price":50000}',
        trade_history: '[{"symbol":"BTC","pnl":100}]',
        last_venue: 'binance',
        last_symbol: 'BTC/USDT',
        last_timeframe: '1h',
        last_status: 'ok',
        last_error: null,
        last_run_at: 1700000000000,
        updated_at: 1700000100000,
      };

      expect(row.id).toBe('cron_state_001');
      expect(row.job_id).toBe('cron_001');
      expect(row.version).toBe(3);
      expect(row.session_id).toBe('session_001');
      expect(row.prompt_fingerprint).toBe('abc123def');
      expect(row.summary).toBe('BTC price is $50,000');
      expect(row.last_output).toBe('Price check complete');
      expect(row.last_trade).toBe('{"symbol":"BTC","side":"long","price":50000}');
      expect(row.trade_history).toBe('[{"symbol":"BTC","pnl":100}]');
      expect(row.last_venue).toBe('binance');
      expect(row.last_symbol).toBe('BTC/USDT');
      expect(row.last_timeframe).toBe('1h');
      expect(row.last_status).toBe('ok');
      expect(row.last_error).toBeNull();
      expect(row.last_run_at).toBe(1700000000000);
      expect(row.updated_at).toBe(1700000100000);
    });

    it('should accept nullable fields as null', () => {
      const row: CronStateRow = {
        id: 'cron_state_002',
        job_id: 'cron_002',
        version: 1,
        session_id: null,
        prompt_fingerprint: null,
        summary: null,
        last_output: null,
        last_trade: null,
        trade_history: null,
        last_venue: null,
        last_symbol: null,
        last_timeframe: null,
        last_status: null,
        last_error: null,
        last_run_at: null,
        updated_at: 1700000000000,
      };

      expect(row.session_id).toBeNull();
      expect(row.prompt_fingerprint).toBeNull();
      expect(row.summary).toBeNull();
      expect(row.last_output).toBeNull();
      expect(row.last_trade).toBeNull();
      expect(row.trade_history).toBeNull();
      expect(row.last_venue).toBeNull();
      expect(row.last_symbol).toBeNull();
      expect(row.last_timeframe).toBeNull();
      expect(row.last_status).toBeNull();
      expect(row.last_error).toBeNull();
      expect(row.last_run_at).toBeNull();
    });
  });

  describe('TradeRow', () => {
    it('should create a valid trade row', () => {
      const row: TradeRow = {
        id: 'trade_001',
        session_id: 'session_001',
        symbol: 'BTC/USDT',
        side: 'long',
        entry_price: 45000,
        exit_price: null,
        quantity: 0.5,
        pnl: null,
        pnl_percent: null,
        status: 'open',
        chain_id: null,
        tx_hash: null,
        dex: null,
        metadata: '{"strategy":"momentum"}',
        opened_at: 1700000000000,
        closed_at: null,
      };

      expect(row.id).toBe('trade_001');
      expect(row.session_id).toBe('session_001');
      expect(row.symbol).toBe('BTC/USDT');
      expect(row.side).toBe('long');
      expect(row.entry_price).toBe(45000);
      expect(row.exit_price).toBeNull();
      expect(row.quantity).toBe(0.5);
      expect(row.pnl).toBeNull();
      expect(row.pnl_percent).toBeNull();
      expect(row.status).toBe('open');
      expect(row.chain_id).toBeNull();
      expect(row.tx_hash).toBeNull();
      expect(row.dex).toBeNull();
      expect(row.metadata).toBe('{"strategy":"momentum"}');
      expect(row.opened_at).toBe(1700000000000);
      expect(row.closed_at).toBeNull();
    });

    it('should accept closed trade with all values', () => {
      const row: TradeRow = {
        id: 'trade_002',
        session_id: 'session_001',
        symbol: 'ETH/USDT',
        side: 'short',
        entry_price: 3000,
        exit_price: 2800,
        quantity: 1.0,
        pnl: 200,
        pnl_percent: 6.67,
        status: 'closed',
        chain_id: 123456,
        tx_hash: '0xabcdef1234567890',
        dex: 'uniswap_v3',
        metadata: '{}',
        opened_at: 1700000000000,
        closed_at: 1700000100000,
      };

      expect(row.exit_price).toBe(2800);
      expect(row.pnl).toBe(200);
      expect(row.pnl_percent).toBe(6.67);
      expect(row.status).toBe('closed');
      expect(row.chain_id).toBe(123456);
      expect(row.tx_hash).toBe('0xabcdef1234567890');
      expect(row.dex).toBe('uniswap_v3');
      expect(row.closed_at).toBe(1700000100000);
    });
  });

  describe('PositionRow', () => {
    it('should create a valid position row', () => {
      const row: PositionRow = {
        id: 'pos_001',
        session_id: 'session_001',
        symbol: 'BTC/USDT',
        side: 'long',
        quantity: 0.5,
        avg_entry_price: 45000,
        current_price: 46000,
        unrealized_pnl: 500,
        unrealized_pnl_percent: 2.22,
        realized_pnl: 0,
        status: 'open',
        metadata: '{"strategy":"momentum"}',
        opened_at: 1700000000000,
        updated_at: 1700000100000,
      };

      expect(row.id).toBe('pos_001');
      expect(row.session_id).toBe('session_001');
      expect(row.symbol).toBe('BTC/USDT');
      expect(row.side).toBe('long');
      expect(row.quantity).toBe(0.5);
      expect(row.avg_entry_price).toBe(45000);
      expect(row.current_price).toBe(46000);
      expect(row.unrealized_pnl).toBe(500);
      expect(row.unrealized_pnl_percent).toBe(2.22);
      expect(row.realized_pnl).toBe(0);
      expect(row.status).toBe('open');
      expect(row.metadata).toBe('{"strategy":"momentum"}');
      expect(row.opened_at).toBe(1700000000000);
      expect(row.updated_at).toBe(1700000100000);
    });
  });

  describe('PortfolioSnapshotRow', () => {
    it('should create a valid portfolio snapshot row', () => {
      const row: PortfolioSnapshotRow = {
        id: 'snap_001',
        session_id: 'session_001',
        total_value: 100000,
        cash_balance: 50000,
        invested: 50000,
        unrealized_pnl: 500,
        realized_pnl: 1000,
        positions_count: 3,
        snapshot: '{"positions":[{"symbol":"BTC/USDT","qty":0.5}],"total_value":100000}',
        taken_at: 1700000000000,
      };

      expect(row.id).toBe('snap_001');
      expect(row.session_id).toBe('session_001');
      expect(row.total_value).toBe(100000);
      expect(row.cash_balance).toBe(50000);
      expect(row.invested).toBe(50000);
      expect(row.unrealized_pnl).toBe(500);
      expect(row.realized_pnl).toBe(1000);
      expect(row.positions_count).toBe(3);
      expect(row.snapshot).toBe('{"positions":[{"symbol":"BTC/USDT","qty":0.5}],"total_value":100000}');
      expect(row.taken_at).toBe(1700000000000);
    });
  });

  describe('PriceCacheRow', () => {
    it('should create a valid price cache row', () => {
      const row: PriceCacheRow = {
        id: 'price_001',
        symbol: 'BTC/USDT',
        price: 50000.42,
        source: 'binance',
        fetched_at: 1700000000000,
      };

      expect(row.id).toBe('price_001');
      expect(row.symbol).toBe('BTC/USDT');
      expect(row.price).toBe(50000.42);
      expect(row.source).toBe('binance');
      expect(row.fetched_at).toBe(1700000000000);
    });
  });

  describe('StateMetaRow', () => {
    it('should create a valid state meta row', () => {
      const row: StateMetaRow = {
        key: 'schema_version',
        value: '1',
        updated_at: 1700000000000,
      };

      expect(row.key).toBe('schema_version');
      expect(row.value).toBe('1');
      expect(row.updated_at).toBe(1700000000000);
    });
  });
});
