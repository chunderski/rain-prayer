#!/usr/bin/env python3
"""Rain Prayer - A simple tool to generate a rain-summoning ritual."""

import random
from datetime import datetime

PRAYERS = [
    "Oh sky, crack open and weep for us.",
    "Clouds, gather your tears and let them fall.",
    "Thunder, roar your approval and bring the downpour.",
    "Rain, we call you home. The earth is thirsty.",
    "Let the heavens open and wash away the drought.",
]

LOCATIONS = ["Denver", "the plains", "the mountains", "wherever you are"]

def generate_prayer():
    prayer = random.choice(PRAYERS)
    location = random.choice(LOCATIONS)
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    return f"{prayer}\n\nLocation: {location}\nTime: {timestamp}\n\nMay it rain soon."

if __name__ == "__main__":
    print(generate_prayer())