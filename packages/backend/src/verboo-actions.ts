import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  scaffolderActionsExtensionPoint,
  createTemplateAction,
} from '@backstage/plugin-scaffolder-node';
import { promises as fs } from 'fs';
import * as path from 'path';

const SYSTEM_PROMPT = `You are a platform engineer.
Generate the file structure for a Python project.
Include: a Dockerfile, requirements.txt, a minimal FastAPI app, and Kubernetes manifests.
For security, you MUST include Kyverno policies for validation (do not use OPA).
Always include a catalog-info.yaml Backstage entity of kind Component at the repository root, with exactly this shape:
---
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: <repository-name>
  description: <short description>
  annotations:
    github.com/project-slug: Tech-Preta/<repository-name>
spec:
  type: service
  lifecycle: production
  owner: group:tech-preta
---
Do not add any other fields to catalog-info.yaml (no system, no language, no metadata.owner).
Return strictly a JSON object in the format: {"files": [{"path": "main.py", "content": "..."}]}
No markdown fences, no explanations - JSON only.`;

// ponytail: naive JSON parse + fence stripping; if the model keeps emitting
// prose around JSON, add a proper repair pass (jsonrepair) here.
function parseAiJson(raw: string): { files: { path: string; content: string }[] } {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const parsed = JSON.parse(stripped);
  if (!Array.isArray(parsed.files)) {
    throw new Error('AI response did not contain a "files" array');
  }
  // trust boundary: the AI output is untrusted input that becomes file writes
  for (const f of parsed.files) {
    if (
      typeof f?.path !== 'string' ||
      typeof f?.content !== 'string' ||
      path.isAbsolute(f.path) ||
      f.path.split(/[\\/]/).includes('..')
    ) {
      throw new Error(`AI returned an invalid or unsafe file path: ${JSON.stringify(f?.path)}`);
    }
  }
  return parsed;
}

export const createVerbooGenerateAction = () => {
  return createTemplateAction({
    id: 'verboo:generate:python',
    description:
      'Generates a Python project using the deepseek-v4-flash model via the Verboo gateway.',
    schema: {
      input: z => z.object({
        prompt: z
          .string()
          .describe('Natural-language description of what the API should do'),
      }),
      output: z => z.object({
        fileCount: z.number(),
      }),
    },
    async handler(ctx) {
      ctx.logger.info(`Calling Verboo AI with prompt: ${ctx.input.prompt}`);

      const apiKey = process.env.VERBOO_API_KEY;
      if (!apiKey) {
        throw new Error('VERBOO_API_KEY is not set (check your .env file)');
      }
      const endpoint =
        process.env.VERBOO_ENDPOINT ?? 'https://code.verboo.ai/router/v1';

      try {
        const response = await fetch(`${endpoint}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'deepseek-v4-flash',
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: ctx.input.prompt },
            ],
            // ponytail: no response_format - Verboo plan rejects it (403
            // structured_output_not_enabled); JSON is enforced via prompt +
            // parseAiJson fence stripping instead.
          }),
          signal: AbortSignal.timeout(120_000),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `Verboo API returned ${response.status}: ${body.slice(0, 500)}`,
          );
        }

        const data = await response.json();
        const aiContent = parseAiJson(data.choices[0].message.content);

        for (const file of aiContent.files) {
          const fullPath = path.join(ctx.workspacePath, file.path);
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, file.content, 'utf8');
          ctx.logger.info(`Created file: ${file.path}`);
        }
        ctx.output('fileCount', aiContent.files.length);
      } catch (error) {
        ctx.logger.error(`AI API call failed: ${error}`);
        throw error;
      }
    },
  });
};

export const scaffolderVerbooModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'verboo-actions',
  register(env) {
    env.registerInit({
      deps: {
        actions: scaffolderActionsExtensionPoint,
      },
      async init({ actions }) {
        actions.addActions(createVerbooGenerateAction());
      },
    });
  },
});

export default scaffolderVerbooModule;
