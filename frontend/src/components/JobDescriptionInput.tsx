'use client';

interface JobDescriptionInputProps {
  value: string;
  onChange: (value: string) => void;
  onAnalyze: () => void;
  isAnalyzing: boolean;
  disabled?: boolean;
}

export default function JobDescriptionInput({
  value,
  onChange,
  onAnalyze,
  isAnalyzing,
  disabled,
}: JobDescriptionInputProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-black mb-2">
        Job Description
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="Paste the job description here to extract relevant skills and keywords for ATS optimization..."
        rows={8}
        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-y disabled:bg-gray-100 disabled:cursor-not-allowed"
      />
      <div className="flex justify-between items-center mt-2">
        <p className="text-sm text-gray-700">
          {value.length > 0 ? `${value.length} characters` : 'Minimum 50 characters'}
        </p>
        <button
          onClick={onAnalyze}
          disabled={isAnalyzing || value.length < 50 || disabled}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium transition-colors"
        >
          {isAnalyzing ? (
            <span className="flex items-center">
              <svg
                className="animate-spin -ml-1 mr-2 h-4 w-4 text-white"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
              Analyzing...
            </span>
          ) : (
            'Analyze Job'
          )}
        </button>
      </div>
    </div>
  );
}
