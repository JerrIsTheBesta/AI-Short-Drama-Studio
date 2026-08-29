/** 数字人口播专用 H3 视觉锁；所有首次生成与单镜重做入口必须复用。 */
export const DIGITAL_HUMAN_VISUAL_LOCK = [
  'Create one continuous photorealistic talking-head shot using Picture 1 as the immutable visual source.',
  'Exactly one person is visible: the same person from Picture 1 and nobody else.',
  'Preserve the exact facial identity, facial geometry, skin tone, hairstyle, hair length, hair color, body proportions, age, and gender throughout every frame.',
  'Preserve the exact clothing, fabric, color, pattern, collar, sleeves, accessories, and every visible wardrobe detail from Picture 1 without redesign or variation.',
  'Preserve the exact original background, objects, furniture, wall details, lighting direction, shadows, colors, and depth of field from Picture 1.',
  'Use a fully locked tripod camera with the exact same viewpoint, lens perspective, framing, crop, subject scale, head position, and eye line for the entire shot.',
  'No camera movement, no zoom, no pan, no tilt, no orbit, no reframing, no angle change, no cut, and no transition.',
  'Do not add, remove, replace, duplicate, or morph any person, face, body part, clothing item, accessory, background object, text, logo, or prop.',
  'Only subtle natural blinking, minimal breathing, tiny head motion, and accurate speaking lip motion are allowed.'
].join(' ')

export const DIGITAL_HUMAN_AESTHETIC =
  'Photorealistic single-person talking-head footage with strict visual continuity and no visual redesign.'

export const DIGITAL_HUMAN_AUDIO_DESCRIPTION =
  'Clean synchronized speech with unchanged quiet room tone. No music and no additional voices.'

export const DIGITAL_HUMAN_SPEAKER_HINT =
  'natural, trustworthy, friendly Mandarin delivery at a stable pace with clear articulation'

export const DIGITAL_HUMAN_SPEAKER_NAME = 'the only on-screen speaker'

export const DIGITAL_HUMAN_SCENE_NAME = 'the unchanged original background from Picture 1'

export const DIGITAL_HUMAN_SCENE_DESCRIPTION =
  'The complete background, lighting, framing, and viewpoint remain identical to Picture 1 for every frame.'

export const DIGITAL_HUMAN_SCENE_ANCHOR = 'the exact immutable background shown in Picture 1'

export const DIGITAL_HUMAN_IMAGE_ASSIGNMENT =
  'the only on-screen person and the complete immutable visual reference; lock identity, face, hair, clothing, accessories, body proportions, background, lighting, framing, and camera angle'

