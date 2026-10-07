const baseline = {
  openapi: '3.1.1',
  info: {
    title: 'Workspace Reservations API',
    version: '1.4.0',
    description: 'Illustrative contract for a shared workspace booking service.',
  },
  paths: {
    '/reservations': {
      get: {
        summary: 'List reservations',
        parameters: [
          {
            name: 'location',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['north', 'south'] },
          },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'A page of reservations',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['reservations', 'nextCursor'],
                  properties: {
                    reservations: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Reservation' },
                    },
                    nextCursor: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        summary: 'Book a workspace',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['workspaceId'],
                properties: { workspaceId: { type: 'string' }, note: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Reservation created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Reservation' } },
            },
          },
        },
      },
    },
    '/reservations/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      delete: {
        summary: 'Cancel a reservation',
        responses: { '204': { description: 'Cancelled' } },
      },
    },
  },
  components: {
    schemas: {
      Reservation: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['confirmed', 'cancelled'] },
        },
      },
    },
  },
};

const candidate = structuredClone(baseline);
candidate.info.version = '2.0.0-rc.1';
candidate.paths['/reservations'].get.parameters[0].required = true;
candidate.paths['/reservations'].get.parameters[0].schema.enum?.push('east');
candidate.paths['/reservations'].get.responses['200'].content['application/json'].schema.required =
  ['reservations'];
candidate.paths['/reservations'].post.requestBody.content['application/json'].schema.required.push(
  'note',
);
candidate.components.schemas.Reservation.properties.status.enum.push('pending');
// A retired operation and a new health endpoint make operation-level changes visible.
delete (candidate.paths as Record<string, unknown>)['/reservations/{id}'];
(candidate.paths as Record<string, unknown>)['/health'] = {
  get: { summary: 'Service health', responses: { '204': { description: 'Healthy' } } },
};

export const BASELINE_SAMPLE = JSON.stringify(baseline, null, 2);
export const CANDIDATE_SAMPLE = JSON.stringify(candidate, null, 2);
