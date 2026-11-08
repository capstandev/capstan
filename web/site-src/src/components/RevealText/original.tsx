"use client";

import { motion } from "framer-motion";
import { useState, useEffect } from "react";

interface RevealTextProps {
  text?: string;
  textColor?: string;
  overlayColor?: string;
  fontSize?: string;
  letterDelay?: number;
  overlayDelay?: number;
  overlayDuration?: number;
  springDuration?: number;
  letterImages?: string[];
}

export function RevealText({
  text = "STUNNING",
  textColor = "text-white",
  overlayColor = "text-red-500",
  fontSize = "text-[250px]",
  letterDelay = 0.08,
  overlayDelay = 0.05,
  overlayDuration = 0.4,
  springDuration = 600,
  letterImages = [
    "https://cdn.21st.dev/assets/mirror/0b/0b9ef6fff23ee3255a419d5ad0e5c6610d9a4e54a3441136e15f01b255594567.jpg", // S
    "https://cdn.21st.dev/assets/mirror/44/4481032f50f8d688268b28e49f0c1944bc9d46a9be1d8744f318483251fb4ca5.jpg", // T
    "https://cdn.21st.dev/assets/mirror/dc/dce249444517cd0fbadad8db875f59fd1730bd60dbd0fa1a49e4a23b58a19fd6.jpg", // U
    "https://cdn.21st.dev/assets/mirror/75/75be0ee67518d0db10eeea6afedad0aa6d6036fff0a3938dc2bda35f4e4333ff.jpg", // N
    "https://cdn.21st.dev/assets/mirror/4c/4c974d71baca0cabdb22ce7f26d11119c71be54d10a943ae94822a1ab21026ca.jpg", // N
    "https://cdn.21st.dev/assets/mirror/cc/ccf3cb0926c7d42b54f1a8bfc4ff63bd97a73ee71d667a1af7d2a1999b062b53.jpg", // I
    "https://cdn.21st.dev/assets/mirror/c5/c57bcf57be1f52e138b02dab40ba18a6a42823d9068172020eea1ac645068626.jpg", // N
    "https://cdn.21st.dev/assets/mirror/f4/f490732d34c74d72126780e3b77ed573fdac5b603079c2b9ffff04f0150cef6d.jpg", // G
  ]
}: RevealTextProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [showRedText, setShowRedText] = useState(false);
  
  useEffect(() => {
    // Calculate when the last letter animation completes
    // Last letter starts at (text.length - 1) * letterDelay seconds
    // Add springDuration for the spring animation to settle
    const lastLetterDelay = (text.length - 1) * letterDelay;
    const totalDelay = (lastLetterDelay * 1000) + springDuration;
    
    const timer = setTimeout(() => {
      setShowRedText(true);
    }, totalDelay);
    
    return () => clearTimeout(timer);
  }, [text.length, letterDelay, springDuration]);

  return (
    <div className="flex items-center justify-center relative">
      <div className="flex">
        {text.split("").map((letter, index) => (
          <motion.span
            key={index}
            onMouseEnter={() => setHoveredIndex(index)}
            onMouseLeave={() => setHoveredIndex(null)}
            className={`${fontSize} font-black tracking-tight cursor-pointer relative overflow-hidden`}
            initial={{ 
              scale: 0,
              opacity: 0,
            }}
            animate={{ 
              scale: 1,
              opacity: 1,
            }}
            transition={{
              delay: index * letterDelay,
              type: "spring",
              damping: 8,
              stiffness: 200,
              mass: 0.8,
            }}
          >
            {/* Base text layer */}
            <motion.span 
              className={`absolute inset-0 ${textColor}`}
              animate={{ 
                opacity: hoveredIndex === index ? 0 : 1 
              }}
              transition={{ duration: 0.1 }}
            >
              {letter}
            </motion.span>
            {/* Image text layer with background panning */}
            <motion.span
              className="text-transparent bg-clip-text bg-cover bg-no-repeat"
              animate={{ 
                opacity: hoveredIndex === index ? 1 : 0,
                backgroundPosition: hoveredIndex === index ? "10% center" : "0% center"
              }}
              transition={{ 
                opacity: { duration: 0.1 },
                backgroundPosition: { 
                  duration: 3,
                  ease: "easeInOut"
                }
              }}
              style={{
                backgroundImage: `url('${letterImages[index % letterImages.length]}')`,
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              {letter}
            </motion.span>
            
            {/* Overlay text layer that sweeps across each letter */}
            {showRedText && (
              <motion.span
                className={`absolute inset-0 ${overlayColor} pointer-events-none`}
                initial={{ opacity: 0 }}
                animate={{ 
                  opacity: [0, 1, 1, 0]
                }}
                transition={{
                  delay: index * overlayDelay,
                  duration: overlayDuration,
                  times: [0, 0.1, 0.7, 1],
                  ease: "easeInOut"
                }}
              >
                {letter}
              </motion.span>
            )}
          </motion.span>
        ))}
      </div>
    </div>
  );
}
