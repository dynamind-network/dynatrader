import { describe, expect, it } from 'vitest';
import parseKeypress from './parse-keypress.js';

describe('parseKeypress editing keys', () => {
	it('treats DEL as Backspace, as sent by Windows Terminal', () => {
		expect(parseKeypress('\x7f').name).toBe('backspace');
	});

	it('keeps CSI Delete mapped to forward Delete', () => {
		expect(parseKeypress('\x1b[3~').name).toBe('delete');
	});
});
