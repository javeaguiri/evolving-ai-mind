// Dynamic registry - now includes ping test
export const getCommands = () => [
  { 
    name: '/ping [1-10]', 
    description: 'Test Vercel→LLM connections (default: 3 pings)', 
    category: '🧪 Testing',
    example: '/ping 5'
  },
  { 
    name: '/second-brain help', 
    description: 'Show all available commands', 
    category: 'Core' 
  }
];
