import { describe, expect, it } from 'vitest';
import { param, tool } from './test-helpers/mock-wiro';
import {
  booleanSettingValue,
  fillRequiredDefaults,
  largestValue,
  matchLanguage,
  matchOption,
  matchRatio,
  parseModelSchema,
  pickNumberOption,
  pickResolution,
  promptParameter,
  ratioOf,
  type WiroParameter,
} from './wiro-model-schema';

function schemaOf(...parameters: Parameters<typeof param>[]) {
  return parseModelSchema(
    'owner/model',
    tool(
      'owner/model',
      parameters.map((args) => param(...args)),
    ),
  );
}

function only(...args: Parameters<typeof param>): WiroParameter {
  const parameter = schemaOf(args).parameters[0];
  if (!parameter) throw new Error('no parameter');
  return parameter;
}

const KOKORO_LANGUAGES = only('langCode', 'select', {
  options: [
    { value: 'a', text: 'American English' },
    { value: 'b', text: 'British English' },
    { value: 'e', text: 'Spanish' },
    { value: 'p', text: 'Brazilian Portuguese' },
  ],
});

describe('parseModelSchema', () => {
  it('reads parameters, options, limits and required flags', () => {
    const schema = parseModelSchema(
      'owner/model',
      tool('owner/model', [
        param('prompt', 'textarea', { required: true }),
        param('steps', 'number', { defaultvalue: '9', minvalue: '1', maxvalue: '50' }),
        param('ratio', 'select', { options: ['1:1', '16:9'], defaultvalue: '1:1' }),
        param('voice', 'select', { options: [{ value: 'af_nova', text: 'Nova' }] }),
      ]),
    );

    expect(schema.parameters.map((parameter) => parameter.id)).toEqual([
      'prompt',
      'steps',
      'ratio',
      'voice',
    ]);
    expect(schema.parameters[0]?.required).toBe(true);
    expect(schema.parameters[1]).toMatchObject({ min: 1, max: 50, defaultValue: '9' });
    expect(schema.parameters[3]?.options).toEqual([{ value: 'af_nova', label: 'Nova' }]);
  });

  it('reads string flags such as required: "true"', () => {
    const schema = parseModelSchema('owner/model', {
      parameters: [{ items: [{ id: 'seed', type: 'TEXT', required: 'true', advanced: 'true' }] }],
    });
    expect(schema.parameters[0]).toMatchObject({ type: 'text', required: true, advanced: true });
  });
});

describe('promptParameter', () => {
  it('finds prompt, then other text inputs, and skips negative prompts', () => {
    expect(
      promptParameter(schemaOf(['negativePrompt', 'textarea'], ['prompt', 'textarea']))?.id,
    ).toBe('prompt');
    expect(promptParameter(schemaOf(['text', 'textarea']))?.id).toBe('text');
    expect(promptParameter(schemaOf(['negativePrompt', 'textarea']))).toBeUndefined();
  });
});

describe('matchOption', () => {
  const voice = only('voice', 'select', {
    options: [
      { value: 'af_nova', text: 'Nova' },
      { value: 'Achernar', text: 'Achernar Female' },
    ],
  });

  it('matches values, values in another case and labels', () => {
    expect(matchOption(voice, 'af_nova')).toBe('af_nova');
    expect(matchOption(voice, 'achernar')).toBe('Achernar');
    expect(matchOption(voice, 'nova')).toBe('af_nova');
    expect(matchOption(voice, 'alloy')).toBeUndefined();
  });
});

describe('matchLanguage', () => {
  it('maps ISO codes to codes, names and labelled letters', () => {
    expect(
      matchLanguage(only('languageCode', 'select', { options: ['auto', 'en', 'tr'] }), 'en'),
    ).toBe('en');
    expect(
      matchLanguage(only('language', 'select', { options: ['auto', 'English', 'Turkish'] }), 'tr'),
    ).toBe('Turkish');
    expect(
      matchLanguage(only('language', 'select', { options: ['auto', 'english', 'spanish'] }), 'es'),
    ).toBe('spanish');
    expect(matchLanguage(KOKORO_LANGUAGES, 'en')).toBe('a');
    expect(matchLanguage(KOKORO_LANGUAGES, 'en-GB')).toBe('b');
    expect(matchLanguage(KOKORO_LANGUAGES, 'pt')).toBe('p');
    expect(matchLanguage(KOKORO_LANGUAGES, 'ja')).toBeUndefined();
  });

  it('keeps auto', () => {
    expect(
      matchLanguage(only('language', 'select', { options: ['auto', 'English'] }), 'auto'),
    ).toBe('auto');
  });
});

describe('ratios and resolutions', () => {
  it('reduces sizes to ratios', () => {
    expect(ratioOf(1920, 1080)).toBe('16:9');
    expect(ratioOf(1024, 1024)).toBe('1:1');
    expect(ratioOf(1536, 1024)).toBe('3:2');
  });

  it('matches ratios written another way', () => {
    const ratio = only('aspectRatio', 'select', { options: ['16:9', '2:1', '19.5:9'] });
    expect(matchRatio(ratio, '16:9')).toBe('16:9');
    expect(matchRatio(ratio, '4:2')).toBe('2:1');
    expect(matchRatio(ratio, '39:18')).toBe('19.5:9');
    expect(matchRatio(ratio, '1:1')).toBeUndefined();
  });

  it('picks the closest resolution by pixel count', () => {
    const video = only('resolution', 'select', { options: ['480p', '720p', '1080p'] });
    expect(pickResolution(video, 1280, 720, 'video')).toEqual({ value: '720p', exact: true });
    expect(pickResolution(video, 720, 1280, 'video')).toEqual({ value: '720p', exact: true });
    expect(pickResolution(video, 1100, 1100, 'video')).toEqual({ value: '720p', exact: false });

    const image = only('resolution', 'select', { options: ['1k', '2k', '4k'] });
    expect(pickResolution(image, 1024, 1024, 'image')).toEqual({ value: '1k', exact: true });
    expect(pickResolution(image, 2048, 2048, 'image')).toEqual({ value: '2k', exact: true });

    const sized = only('size', 'select', { options: ['1024x1024', '1536x1024', '1024x1536'] });
    expect(pickResolution(sized, 1536, 1024, 'image')?.value).toBe('1536x1024');
    expect(pickResolution(sized, 1024, 1536, 'image')?.value).toBe('1024x1536');
  });

  it('picks the closest number option', () => {
    const duration = only('duration', 'select', { options: ['5', '10'] });
    expect(pickNumberOption(duration, 5)).toEqual({ value: '5', exact: true });
    expect(pickNumberOption(duration, 8)).toEqual({ value: '10', exact: false });
  });
});

describe('booleanSettingValue', () => {
  it('uses the words the setting offers', () => {
    expect(booleanSettingValue(only('a', 'select', { options: ['false', 'true'] }), true)).toBe(
      'true',
    );
    expect(booleanSettingValue(only('sound', 'select', { options: ['on', 'off'] }), false)).toBe(
      'off',
    );
    expect(booleanSettingValue(only('c', 'checkbox'), true)).toBe('true');
    expect(
      booleanSettingValue(only('d', 'select', { options: ['low', 'high'] }), true),
    ).toBeUndefined();
  });
});

describe('fillRequiredDefaults', () => {
  it('fills required selects, numbers and checkboxes, but not text or files', () => {
    const schema = schemaOf(
      ['prompt', 'textarea', { required: true, defaultvalue: 'a sample prompt' }],
      [
        'inputImage',
        'combinefileinput',
        { required: true, defaultvalue: 'https://cdn.wiro.ai/a.jpg' },
      ],
      ['resolution', 'select', { required: true, defaultvalue: '1k', options: ['1k', '2k'] }],
      [
        'language',
        'select',
        { required: true, defaultvalue: 'Auto', options: ['auto', 'english'] },
      ],
      ['samples', 'number', { required: true, defaultvalue: '1' }],
      ['diarize', 'checkbox', { required: true, value: 'true' }],
      ['quality', 'select', { defaultvalue: 'low', options: ['low', 'high'] }],
    );
    const params: Record<string, unknown> = { resolution: '2k' };
    fillRequiredDefaults(schema, params);
    expect(params).toEqual({ resolution: '2k', language: 'auto', samples: 1, diarize: 'true' });
  });
});

describe('largestValue', () => {
  it('reads the maximum of a number or of numeric options', () => {
    expect(largestValue(only('samples', 'number', { minvalue: '1', maxvalue: '8' }))).toBe(8);
    expect(largestValue(only('n', 'select', { options: ['1', '2', '4'] }))).toBe(4);
    expect(largestValue(only('n', 'select', { options: ['a'] }))).toBeUndefined();
  });
});
