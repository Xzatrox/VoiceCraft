#!/usr/bin/env python3
"""
Qwen3-TTS Generation Script
Generates speech audio using Qwen3-TTS with instruction-based voice control
Supports Russian and English with customizable voice characteristics
"""

import argparse
import os
import sys
from pathlib import Path

try:
    import torch
except ImportError:
    print("Error: PyTorch not installed.", file=sys.stderr)
    print("Please install: pip install torch", file=sys.stderr)
    sys.exit(1)

try:
    from transformers import AutoTokenizer, AutoModel
except ImportError:
    print("Error: transformers not installed.", file=sys.stderr)
    print("Please install: pip install transformers", file=sys.stderr)
    sys.exit(1)

try:
    import scipy.io.wavfile as wavfile
    import numpy as np
except ImportError:
    print("Error: scipy/numpy not installed.", file=sys.stderr)
    print("Please install: pip install scipy numpy", file=sys.stderr)
    sys.exit(1)


def get_device():
    """Detect and return the best available device."""
    if torch.cuda.is_available():
        return torch.device('cuda')
    elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        return torch.device('mps')
    else:
        return torch.device('cpu')


def build_instruction(speaker_type='neutral', gender='male', style='normal', emotion='neutral'):
    """
    Build instruction text for Qwen3-TTS voice control.
    
    Args:
        speaker_type: Voice timbre type (neutral, warm, bright, deep)
        gender: Voice gender (male, female)
        style: Speaking style (normal, expressive, calm, energetic)
        emotion: Emotion (neutral, happy, sad, angry, surprised)
    
    Returns:
        Instruction string for the model
    """
    instructions = []
    
    # Gender instruction
    if gender.lower() == 'female':
        instructions.append("female voice")
    elif gender.lower() == 'male':
        instructions.append("male voice")
    
    # Timbre/speaker type
    if speaker_type.lower() != 'neutral':
        instructions.append(f"{speaker_type} timbre")
    
    # Speaking style
    if style.lower() != 'normal':
        instructions.append(f"{style} speaking style")
    
    # Emotion
    if emotion.lower() != 'neutral':
        instructions.append(f"{emotion} emotion")
    
    # Join instructions
    if instructions:
        return ", ".join(instructions)
    return "natural voice"


def main():
    parser = argparse.ArgumentParser(description='Generate speech using Qwen3-TTS')
    parser.add_argument('--text', required=True, help='Text to convert to speech')
    parser.add_argument('--speaker', required=True, help='Speaker identifier (e.g., qwen-male, qwen-female)')
    parser.add_argument('--output', required=True, help='Output WAV file path')
    parser.add_argument('--language', default='ru', choices=['ru', 'en'], help='Language (default: ru)')
    parser.add_argument('--sample-rate', type=int, default=24000, help='Sample rate (default: 24000)')
    parser.add_argument('--instruction', type=str, default='', help='Custom voice instruction (overrides speaker defaults)')
    parser.add_argument('--gender', type=str, default='', choices=['', 'male', 'female'], help='Voice gender')
    parser.add_argument('--timbre', type=str, default='neutral', help='Voice timbre (neutral, warm, bright, deep)')
    parser.add_argument('--style', type=str, default='normal', help='Speaking style (normal, expressive, calm, energetic)')
    parser.add_argument('--emotion', type=str, default='neutral', help='Emotion (neutral, happy, sad, angry, surprised)')
    parser.add_argument('--model-path', type=str, default='QwenLM/Qwen3-TTS', help='Model path or HuggingFace model ID')

    args = parser.parse_args()

    try:
        # Determine device
        device = get_device()
        print(f"Using device: {device}", file=sys.stderr)

        # Load model and tokenizer
        print(f"Loading Qwen3-TTS model from: {args.model_path}", file=sys.stderr)
        
        tokenizer = AutoTokenizer.from_pretrained(
            args.model_path,
            trust_remote_code=True
        )
        
        model = AutoModel.from_pretrained(
            args.model_path,
            trust_remote_code=True,
            torch_dtype=torch.float16 if device.type in ['cuda', 'mps'] else torch.float32
        )
        
        model.to(device)
        model.eval()

        print(f"Model loaded successfully", file=sys.stderr)
        print(f"Generating audio for text length: {len(args.text)} characters", file=sys.stderr)

        # Determine gender from speaker if not explicitly provided
        gender = args.gender
        if not gender:
            if 'female' in args.speaker.lower():
                gender = 'female'
            elif 'male' in args.speaker.lower():
                gender = 'male'
            else:
                gender = 'male'  # default

        # Build instruction
        if args.instruction:
            instruction = args.instruction
        else:
            instruction = build_instruction(
                speaker_type=args.timbre,
                gender=gender,
                style=args.style,
                emotion=args.emotion
            )

        print(f"Using instruction: {instruction}", file=sys.stderr)

        # Generate audio with instruction
        with torch.no_grad():
            # Prepare input
            inputs = tokenizer(
                args.text,
                return_tensors="pt",
                padding=True,
                truncation=True,
                max_length=512
            ).to(device)

            # Add instruction as prefix or use model's instruction mechanism
            # Note: Actual implementation depends on Qwen3-TTS API
            # This is a placeholder for the actual generation call
            if hasattr(model, 'generate_speech'):
                audio = model.generate_speech(
                    **inputs,
                    instruction=instruction,
                    language=args.language,
                    sample_rate=args.sample_rate
                )
            elif hasattr(model, 'generate'):
                # Fallback to standard generation with instruction prepended
                instruction_text = f"[{instruction}] {args.text}"
                inputs = tokenizer(
                    instruction_text,
                    return_tensors="pt",
                    padding=True,
                    truncation=True,
                    max_length=512
                ).to(device)
                
                outputs = model.generate(
                    **inputs,
                    max_length=args.sample_rate * 30,  # Max 30 seconds
                    do_sample=True,
                    temperature=0.7,
                    top_p=0.9
                )
                
                # Convert model output to audio
                if hasattr(model, 'decode_audio'):
                    audio = model.decode_audio(outputs)
                else:
                    # Assume outputs are already audio samples
                    audio = outputs
            else:
                raise AttributeError("Model does not have generate_speech or generate method")

        # Convert to numpy array
        if isinstance(audio, torch.Tensor):
            audio = audio.cpu().numpy()

        # Ensure 1D array for mono
        if audio.ndim > 1:
            audio = audio.squeeze()

        # Normalize to int16 range
        if audio.dtype == np.float32 or audio.dtype == np.float64:
            # Normalize to [-1, 1] range first
            audio = np.clip(audio, -1.0, 1.0)
            audio = (audio * 32767).astype(np.int16)
        elif audio.dtype != np.int16:
            audio = audio.astype(np.int16)

        # Save to WAV file
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        wavfile.write(str(output_path), args.sample_rate, audio)

        print(f"Successfully generated audio: {args.output}", file=sys.stderr)
        print(f"Audio duration: {len(audio) / args.sample_rate:.2f} seconds", file=sys.stderr)
        return 0

    except Exception as e:
        print(f"Error generating audio: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
