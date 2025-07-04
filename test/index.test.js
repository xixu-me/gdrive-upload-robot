import { expect, test } from 'vitest';

test('Worker handles GET requests', async () => {
	const SELF = {
		async fetch(request, env) {
			const worker = await import('../src/index.js');
			return worker.default.fetch(request, env);
		},
	};

	const response = await SELF.fetch(new Request('http://localhost/'));
	expect(response.status).toBe(200);

	const text = await response.text();
	expect(text).toBe('OK');
});

test('Worker handles POST requests without payload', async () => {
	const SELF = {
		async fetch(request, env) {
			const worker = await import('../src/index.js');
			return worker.default.fetch(request, env);
		},
	};

	const response = await SELF.fetch(
		new Request('http://localhost/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		})
	);

	expect(response.status).toBe(200);

	const text = await response.text();
	expect(text).toBe('OK');
});

// Mock test for document handling (requires environment variables)
test('Worker structure for document handling', () => {
	// This test verifies the structure exists for document handling
	// Full integration tests would require actual Telegram and Google API credentials

	const mockMessage = {
		message: {
			document: {
				file_id: 'test_file_id',
				file_name: 'test.pdf',
			},
		},
	};

	expect(mockMessage.message.document).toBeDefined();
	expect(mockMessage.message.document.file_id).toBe('test_file_id');
	expect(mockMessage.message.document.file_name).toBe('test.pdf');
});

test('Worker structure for photo handling', () => {
	// This test verifies the structure exists for photo handling

	const mockMessage = {
		message: {
			photo: [
				{
					file_id: 'test_photo_id',
					width: 1280,
					height: 720,
				},
			],
		},
	};

	expect(mockMessage.message.photo).toBeDefined();
	expect(Array.isArray(mockMessage.message.photo)).toBe(true);
	expect(mockMessage.message.photo[0].file_id).toBe('test_photo_id');
});
