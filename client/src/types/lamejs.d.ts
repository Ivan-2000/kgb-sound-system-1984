declare module 'lamejs' {
  class Mp3Encoder {
    constructor(channels: 1 | 2, sampleRate: number, kbps: number)
    /** Encode a block of PCM samples (Int16). Returns partial MP3 data (may be empty). */
    encodeBuffer(left: Int16Array, right?: Int16Array): Int16Array
    /** Flush remaining MP3 frames. Call once after all blocks. */
    flush(): Int16Array
  }
  export { Mp3Encoder }
}
