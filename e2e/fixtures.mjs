// Faces used to test the face check in a real browser. They are NOT committed as pictures: they are
// cropped at test time from the demo photos that ship inside the face library's package
// (node_modules/@vladmandic/face-api/demo), so no one's photo is redistributed by this repository.
//
// The labels are just labels. The two faces are different people, 0.87 apart when read by the same
// network the app uses, and each reads cleanly (detector score 0.78) at these crops.
export const FACES = {
  personA: { file: 'sample6.jpg', rect: [1344, 226, 501, 437] }, // x, y, width, height in the photo
  personB: { file: 'sample5.jpg', rect: [174, 781, 587, 533] },
  // For the head-turn test: a face looking at the camera (measured turn +0.04; the check does not need
  // zero, it compares each person with their own starting reading), and the same strongly turned face
  // shown both ways. The app asks for a change of 0.12 or more from the starting reading to count as a turn.
  personC: { file: 'sample6.jpg', rect: [995, 227, 490, 438] },
  // The same strongly turned face (measured -0.29) twice: as it is (turned to the person's right) and
  // mirrored (so +0.29, turned to their left). Both are beyond the 0.25 the app accepts as 'looking at
  // the camera', so the only place a starting reading can be taken is the frontal picture.
  turnedLeft: { file: 'sample1.jpg', rect: [1351, 98, 504, 467], mirror: true },
  turnedRight: { file: 'sample1.jpg', rect: [1351, 98, 504, 467] },
};

// Where the library keeps its demo photos, relative to the repository root.
export const DEMO_PHOTOS = 'node_modules/@vladmandic/face-api/demo';

// A point and a few offsets for the location tests (the numbers only need to be consistent).
export const ROOM = { latitude: 27.7172, longitude: 85.324 };
const METRES_PER_DEGREE = 111_195;
export const metresNorth = (metres) => ({ latitude: ROOM.latitude + metres / METRES_PER_DEGREE, longitude: ROOM.longitude });
